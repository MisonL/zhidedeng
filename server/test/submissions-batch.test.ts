import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminBatchSubmitRequest, AdminBatchSubmitResponse, AdminSubmissionStateResponse, SubmissionRecord } from '@zhidedeng/shared';
import type { StationRecord, Store } from '../src/database.ts';
import { createApp, openDatabase, openStore } from '../src/node-app.ts';
import { enqueueSubmission, listSubmissions, reviewSubmission, setAutoApprove } from '../src/submissions.ts';
import { buildBatch, planBatch } from '../../scripts/sync-feishu.ts';

const TOKEN = 'batch-admin-tests-0123456789abcdef';
const admin = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const clock = () => new Date('2026-11-07T06:00:00Z');
type Item = AdminBatchSubmitRequest['items'][number];
type ReviewResponse = { results: { id: string; submission?: SubmissionRecord; error?: { status: number; code: string } }[] };

let server: ReturnType<typeof createApp>;
let store: Store;
beforeEach(() => {
  server = createApp({ dbPath: ':memory:', now: clock, syncToken: TOKEN });
  store = openStore(server.db);
});
afterEach(() => server.db.close());

const stationItem = (host = 'batch.example.com'): Item => ({
  kind: 'station', originKey: host, action: 'upsert',
  payload: {
    name: host, description: '飞书批次站点', url: `https://${host}/`,
    rechargeThreshold: 10, paymentMethods: ['支付宝'], offers: [{ modelSlug: 'gpt-4-1', rate: 0.5 }],
    uptime: 99.9, firstTokenLatencyMs: 123, foundedAt: '2020-01-01', status: 'running',
  },
});
const postItem: Item = {
  kind: 'post', originKey: 'rec-review',
  payload: { title: '群友评价', summary: '评价摘要', body: '评价正文', authorName: '群友', hostname: 'batch.example.com' },
};
const modelItem: Item = {
  kind: 'model', originKey: 'batch-model',
  payload: { slug: 'batch-model', vendor: 'openai', name: '批次模型', description: '批次新增模型' },
};
const send = (path: string, body: unknown) => server.app.request(path, { method: 'POST', headers: admin, body: JSON.stringify(body) });
const submit = async (items: Item[], batchId?: string) => {
  const response = await send('/api/admin/submissions/batch', { channel: 'feishu', batchId, items });
  expect(response.status).toBe(200);
  return await response.json() as AdminBatchSubmitResponse;
};
const batchReview = async (batchId: string, status: 'approved' | 'rejected' = 'approved') => {
  const response = await send('/api/admin/submissions/batch-review', { batchId, status, reason: '整批核实' });
  expect(response.status).toBe(200);
  return await response.json() as ReviewResponse;
};
const state = async () => {
  const response = await server.app.request('/api/admin/submissions/state', { headers: admin });
  expect(response.status).toBe(200);
  return await response.json() as AdminSubmissionStateResponse;
};
const approveStation = (host = 'batch.example.com', channel: 'feishu' | 'agent' = 'feishu') => {
  const { submission } = enqueueSubmission(store, { ...stationItem(host), channel, ip: '127.0.0.1', now: clock() });
  reviewSubmission(store, clock(), submission.id, { status: 'approved' });
  return store.all('station').find(station => station.url === `https://${host}/`)!;
};
const removalItem = (station: StationRecord, submissionId = listSubmissions(store, { kind: 'station', status: 'approved', pageSize: 50 }).items
  .filter(item => item.originKey === new URL(station.url!).hostname).at(-1)!.id): Item => ({
  kind: 'station', originKey: new URL(station.url!).hostname, action: 'remove', payload: { slug: station.slug, submissionId },
});

describe('批次入队与审核', () => {
  it('服务端生成统一 batchId，逐条返回结果并沿用 pending 幂等', async () => {
    const result = await submit([stationItem(), stationItem('other.example.com'), postItem]);
    expect(result.batchId).toBeTruthy();
    expect(result.results).toMatchObject([
      { originKey: 'batch.example.com', kind: 'station', status: 'pending', deduplicated: false, autoApproved: false },
      { originKey: 'other.example.com', kind: 'station', status: 'pending', deduplicated: false, autoApproved: false },
      { originKey: 'rec-review', kind: 'post', status: 'pending', deduplicated: false, autoApproved: false },
    ]);
    expect(result.results[1].id).not.toBe(result.results[0].id);
    expect(listSubmissions(store, {}).items).toHaveLength(3);
    expect(listSubmissions(store, {}).items.every(item => item.batchId === result.batchId && item.action === 'upsert')).toBe(true);
    expect(store.all('station').find(station => station.name === 'batch.example.com')).toBeUndefined();
  });

  it('列表按 batchId 过滤，重复请求同一批次不重复入队', async () => {
    const first = await submit([stationItem()], 'batch-one');
    await submit([stationItem('other.example.com')], 'batch-two');
    const appended = await submit([stationItem('pending-addition.example.com')], first.batchId);
    expect(appended.results[0]).toMatchObject({ status: 'pending', deduplicated: false });
    const repeated = await submit([stationItem()], 'batch-one');
    expect(repeated.results[0]).toMatchObject({ id: first.results[0].id, deduplicated: true });
    const response = await server.app.request('/api/admin/submissions?batchId=batch-one', { headers: admin });
    expect(await response.json()).toMatchObject({ total: 2, items: [
      { id: first.results[0].id, batchId: 'batch-one' },
      { id: appended.results[0].id, batchId: 'batch-one' },
    ] });
  });

  it('SQLITE_BUSY 使批次整体返回 503，不降级成逐条 INTERNAL_ERROR', async () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const exec = vi.spyOn(server.db, 'exec').mockImplementation(sql => {
      if (sql === 'BEGIN IMMEDIATE') throw busy;
      return server.db;
    });
    try {
      const response = await send('/api/admin/submissions/batch', {
        channel: 'feishu', items: [stationItem(), postItem],
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'BUSY', message: '数据库繁忙，请重试' } });
      expect(listSubmissions(store, {}).total).toBe(0);
    } finally {
      exec.mockRestore();
    }
  });

  it.each(['/api/admin/submissions/batch', '/api/admin/submissions', '/api/admin/submissions/batch-review'] as const)('%s 在真实文件库写锁超时时返回 503', async path => {
    const directory = mkdtempSync(join(tmpdir(), 'submissions-busy-'));
    const dbPath = join(directory, 'locked.db');
    const locked = createApp({ dbPath, now: clock, syncToken: TOKEN });
    const writer = new DatabaseSync(dbPath);
    const item = stationItem();
    const lockedStore = openStore(locked.db);
    const body = path.endsWith('batch-review')
      ? { ids: [enqueueSubmission(lockedStore, { ...item, channel: 'feishu', ip: '127.0.0.1', now: clock() }).submission.id], status: 'approved' }
      : path.endsWith('batch') ? { channel: 'feishu', items: [item, postItem] } : { ...item, channel: 'feishu' };
    locked.db.exec('PRAGMA busy_timeout = 1');
    writer.exec('BEGIN IMMEDIATE');
    try {
      const response = await locked.app.request(path, { method: 'POST', headers: admin, body: JSON.stringify(body) });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: 'BUSY', message: '数据库繁忙，请重试' } });
      expect(listSubmissions(lockedStore, { status: 'approved' }).total).toBe(0);
      expect(listSubmissions(lockedStore, { status: 'pending' }).total).toBe(path.endsWith('batch-review') ? 1 : 0);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
      locked.db.close();
      rmSync(directory, { recursive: true });
    }
  });

  it('批次中的其他数据库异常向上抛出，不伪装成逐条业务错误', async () => {
    server.db.exec("CREATE TRIGGER fail_submission_insert BEFORE INSERT ON submissions BEGIN SELECT RAISE(ABORT, '入队写入失败'); END;");
    const response = await send('/api/admin/submissions/batch', { channel: 'feishu', items: [stationItem(), postItem] });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' } });
    expect(listSubmissions(store, {}).total).toBe(0);
  });

  it.each(['approved', 'rejected'] as const)('同渠道不能向全部 %s 的 batchId 追加条目', async status => {
    const first = await submit([stationItem()], 'closed-batch');
    await batchReview(first.batchId, status);
    const response = await send('/api/admin/submissions/batch', {
      channel: 'feishu', batchId: first.batchId, items: [stationItem('later.example.com')],
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: {
      code: 'BATCH_ALREADY_REVIEWED', message: '批次已审核完成，不能追加新条目',
    } });
    const direct = await send('/api/admin/submissions', { ...stationItem('single-addition.example.com'), channel: 'feishu', batchId: first.batchId });
    expect(direct.status).toBe(409);
    expect(await direct.json()).toMatchObject({ error: { code: 'BATCH_ALREADY_REVIEWED' } });
    expect(listSubmissions(store, { batchId: first.batchId }).total).toBe(1);
    expect(store.get('station', 'sub-later-example-com')).toBeUndefined();
  });

  it('人工审核理由写为自动通过时，已审完批次仍拒绝追加', async () => {
    const first = await submit([stationItem()], 'manual-auto-reason');
    const reviewed = await send('/api/admin/submissions/batch-review', {
      batchId: first.batchId, status: 'approved', reason: '自动通过',
    });
    expect(reviewed.status).toBe(200);
    expect(await reviewed.json()).toMatchObject({ results: [{ submission: { status: 'approved', reason: '自动通过' } }] });
    expect(server.db.prepare('SELECT autoApproved FROM submissions WHERE id = ?').get(first.results[0].id!)).toEqual({ autoApproved: 0 });

    const response = await send('/api/admin/submissions/batch', {
      channel: 'feishu', batchId: first.batchId, items: [stationItem('later.example.com')],
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'BATCH_ALREADY_REVIEWED' } });
    expect(listSubmissions(store, { batchId: first.batchId }).total).toBe(1);
  });

  it('开启自动通过时，同一批次仍可分多块续传', async () => {
    // 自动通过会把每条立即置为 approved，此时批次里没有 pending；
    // 如果把这当成「批次已审核完成」，超过一块的同步会直接失败。
    setAutoApprove(store, true, clock());
    const first = await submit([stationItem()], 'auto-chunk');
    expect(first.results[0]).toMatchObject({ status: 'approved', autoApproved: true });
    expect(listSubmissions(store, { batchId: first.batchId, status: 'pending' }).total).toBe(0);

    const response = await send('/api/admin/submissions/batch', {
      channel: 'feishu', batchId: 'auto-chunk', items: [stationItem('second-chunk.example.com')],
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { results: { status?: string }[] }).results[0]).toMatchObject({ status: 'approved' });
    expect(store.get('station', 'sub-second-chunk-example-com')).toBeDefined();
    expect(server.db.prepare('SELECT autoApproved FROM submissions WHERE batchId = ? ORDER BY rowid').all(first.batchId))
      .toEqual([{ autoApproved: 1 }, { autoApproved: 1 }]);
  });

  it('相同内容在不同批次各有记录，不从旧批次挪走待审条目', async () => {
    const first = await submit([stationItem()], 'batch-one');
    const second = await submit([stationItem()], 'batch-two');
    expect(second.results[0].id).not.toBe(first.results[0].id);
    expect(listSubmissions(store, { batchId: 'batch-one' }).total).toBe(1);
    expect(listSubmissions(store, { batchId: 'batch-two' }).total).toBe(1);
  });

  it('按 batchId 审核整批，站点、模型和评价都生效，其他批次保持 pending', async () => {
    const batch = await submit([stationItem(), modelItem, postItem]);
    const other = await submit([stationItem('other.example.com')]);
    const result = await batchReview(batch.batchId);
    expect(result.results).toHaveLength(3);
    expect(result.results.every(item => item.submission?.status === 'approved')).toBe(true);
    expect(store.get('station', 'sub-batch-example-com')).toMatchObject({
      source: 'submission', uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null,
    });
    expect(store.get('model', 'batch-model')?.name).toBe('批次模型');
    expect(store.get('post', `sub-${batch.results[2].id}`)).toMatchObject({ stationSlug: 'sub-batch-example-com', source: 'submission' });
    expect(listSubmissions(store, { batchId: other.batchId }).items[0].status).toBe('pending');
  });

  it('整批审核跳过已经单独审核的条目，其余照常通过', async () => {
    const batch = await submit([stationItem(), stationItem('other.example.com'), postItem]);
    await send(`/api/admin/submissions/${batch.results[0].id}/review`, { status: 'approved' });
    const result = await batchReview(batch.batchId);
    expect(result.results.map(item => item.id)).toEqual([batch.results[1].id, batch.results[2].id]);
    expect(result.results.every(item => item.submission?.status === 'approved')).toBe(true);
    expect(listSubmissions(store, { batchId: batch.batchId }).items.every(item => item.status === 'approved')).toBe(true);
    expect((await batchReview(batch.batchId)).results).toEqual([]);
  });

  it('批内未知模型逐条报错，不阻止其余条目入队', async () => {
    const good = stationItem();
    const bad = { ...stationItem('bad.example.com'), payload: {
      ...(stationItem('bad.example.com').payload as object), offers: [{ modelSlug: 'missing-model', rate: 0.5 }],
    } };
    const result = await submit([bad, good, postItem]);
    expect(result.results[0]).toMatchObject({ originKey: 'bad.example.com', error: { code: 'INVALID_INPUT', message: '未知模型：missing-model' } });
    expect(result.results[0].id).toBeUndefined();
    expect(result.results.slice(1).every(item => item.status === 'pending')).toBe(true);
    expect(listSubmissions(store, { batchId: result.batchId }).total).toBe(2);
  });

  it('批内 payload 形状错误只拒绝该条，其他条目保持可审核', async () => {
    const result = await submit([{ ...stationItem(), payload: { url: 'https://batch.example.com/' } }, stationItem('good.example.com')]);
    expect(result.results[0].error?.code).toBe('INVALID_INPUT');
    expect(result.results[1].status).toBe('pending');
    expect((await batchReview(result.batchId)).results[0].submission?.status).toBe('approved');
  });

  it('batchId 审核不受 ids 模式的 100 条上限截断', async () => {
    const batch = await submit(Array.from({ length: 101 }, (_, index) => stationItem(`station-${index}.example.com`)));
    const result = await batchReview(batch.batchId);
    expect(result.results).toHaveLength(101);
    expect(result.results.every(item => item.submission?.status === 'approved')).toBe(true);
    expect(listSubmissions(store, { batchId: batch.batchId, status: 'pending' }).total).toBe(0);
  });

  // 600 条各自入队和审核，多文件并行时可能超过默认 5 秒。
  it('同 batchId 的 500 与 100 条分块仍可一次审核完整 600 条', async () => {
    const first = await submit(Array.from({ length: 500 }, (_, index) => stationItem(`chunk-${index}.example.com`)), 'chunked-batch');
    const second = await submit(Array.from({ length: 100 }, (_, index) => stationItem(`chunk-${index + 500}.example.com`)), 'chunked-batch');
    expect(second.batchId).toBe(first.batchId);
    const result = await batchReview(first.batchId);
    expect(result.results).toHaveLength(600);
    expect(result.results.every(item => item.submission?.status === 'approved')).toBe(true);
    expect(listSubmissions(store, { batchId: first.batchId, status: 'pending' }).total).toBe(0);
  }, 120_000);

  it('501 条批次整批返回 400，不入队任何条目', async () => {
    const response = await send('/api/admin/submissions/batch', {
      channel: 'feishu', items: Array.from({ length: 501 }, (_, index) => ({ ...postItem, originKey: `over-limit-${index}` })),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(listSubmissions(store, {}).total).toBe(0);
  });

  it.each(['upsert/upsert', 'upsert/remove', 'remove/remove'])('同批 %s 规范化 hostname 冲突时整批 400，指出条目且不写入', async actions => {
    const station = approveStation('conflict.example.com');
    const upsert = { ...stationItem(), originKey: '客户端任意 key', payload: {
      ...(stationItem().payload as object), url: 'https://WWW.CONFLICT.EXAMPLE.COM:443/',
    } };
    const removal = { ...removalItem(station), originKey: 'another-client-key' };
    const conflicts = actions === 'upsert/upsert' ? [upsert, stationItem('conflict.example.com')]
      : actions === 'upsert/remove' ? [upsert, removal] : [removal, { ...removal, originKey: 'yet-another-key' }];
    const response = await send('/api/admin/submissions/batch', { channel: 'feishu', items: [postItem, ...conflicts] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: {
      code: 'INVALID_INPUT', message: expect.stringMatching(/第 2 条.*第 3 条.*conflict\.example\.com/),
    } });
    expect(listSubmissions(store, {}).total).toBe(1);
    expect(store.get('station', station.slug)).toEqual(station);
  });

  it('不存在的下架目标也按 hostname 规范化检查同批冲突', async () => {
    const response = await send('/api/admin/submissions/batch', { channel: 'feishu', items: [
      { kind: 'station', originKey: 'BÜCHER.EXAMPLE:443', action: 'remove', payload: { slug: 'sub-missing-one', submissionId: 'missing-a' } },
      { kind: 'station', originKey: 'xn--bcher-kva.example:8443', action: 'remove', payload: { slug: 'sub-missing-two', submissionId: 'missing-b' } },
    ] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INPUT', message: expect.stringContaining('xn--bcher-kva.example') } });
    expect(listSubmissions(store, {}).total).toBe(0);
  });

  it.each([
    ['https://API.EXAMPLE.COM/', 'api.example.com'],
    ['https://bücher.example/', 'xn--bcher-kva.example'],
    ['https://port.example.com:8443/', 'port.example.com'],
    ['https://WWW.EXAMPLE.COM/', 'www.example.com'],
  ])('单条和批量 station 的 %s 覆盖客户端 originKey 为 %s', async (url, hostname) => {
    const item = { ...stationItem(), originKey: 'IGNORED.EXAMPLE:1234', payload: { ...(stationItem().payload as object), url } };
    const response = await send('/api/admin/submissions', { ...item, channel: 'feishu' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ submission: { originKey: hostname } });
    const batch = await submit([item]);
    expect(batch.results[0].id).toBeTruthy();
    expect(server.db.prepare('SELECT originKey FROM submissions ORDER BY rowid').all()).toEqual([{ originKey: hostname }, { originKey: hostname }]);
  });

  it.each([undefined, '不是网址', 'javascript:alert(1)'])('无效 station URL %s 在单条和批次入队前返回 400', async url => {
    const item = { ...stationItem(), payload: { ...(stationItem().payload as object), url } };
    expect((await send('/api/admin/submissions', { ...item, channel: 'feishu' })).status).toBe(400);
    const response = await send('/api/admin/submissions/batch', { channel: 'feishu', items: [postItem, item] });
    expect(response.status).toBe(400);
    expect(listSubmissions(store, {}).total).toBe(0);
  });

  it.each(['pending', 'approved'])('已有 %s 批次不能被其他 channel 从单条或批量入口复用', async status => {
    const first = await submit([stationItem()], 'owned-batch');
    if (status === 'approved') await batchReview(first.batchId);
    const item = stationItem('foreign.example.com');
    for (const [path, body] of [
      ['/api/admin/submissions', { ...item, channel: 'agent', batchId: first.batchId }],
      ['/api/admin/submissions/batch', { channel: 'agent', batchId: first.batchId, items: [item, postItem] }],
    ] as const) {
      const response = await send(path, body);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'BATCH_CHANNEL_MISMATCH' } });
    }
    expect(listSubmissions(store, { batchId: first.batchId }).total).toBe(1);
    expect(store.get('station', 'sub-foreign-example-com')).toBeUndefined();
  });

  it('空批次不占有 channel，新 batchId 可入队，同渠道后续分块正常', async () => {
    const empty = await submit([], 'initially-empty');
    expect(empty.results).toEqual([]);
    const first = await send('/api/admin/submissions/batch', { channel: 'agent', batchId: empty.batchId, items: [stationItem()] });
    expect(first.status).toBe(200);
    const second = await send('/api/admin/submissions/batch', { channel: 'agent', batchId: empty.batchId, items: [stationItem('next.example.com')] });
    expect(second.status).toBe(200);
    expect(listSubmissions(store, { batchId: empty.batchId }).total).toBe(2);
  });

  it('飞书批次沿用导入的 8 MiB 限制，可以超过普通接口的 512 KiB', async () => {
    const batch = await submit(Array.from({ length: 40 }, (_, index) => ({
      ...postItem, originKey: `large-review-${index}`, payload: { ...(postItem.payload as object), body: '字'.repeat(5000) },
    })));
    expect(batch.results).toHaveLength(40);
    expect(batch.results.every(item => item.status === 'pending')).toBe(true);
  });

  it('保留 ids 审核的 100 条限制，拒绝同时给 ids 和 batchId', async () => {
    expect((await send('/api/admin/submissions/batch-review', { ids: Array(101).fill('id'), status: 'approved' })).status).toBe(400);
    expect((await send('/api/admin/submissions/batch-review', { ids: ['id'], batchId: 'batch', status: 'approved' })).status).toBe(400);
  });

  it('批次入队沿用 clientIp，忽略非本机直连伪造的转发头', async () => {
    const response = await server.app.request('/api/admin/submissions/batch', {
      method: 'POST', headers: { ...admin, 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ channel: 'feishu', items: [stationItem(), postItem] }),
    }, { incoming: { socket: { remoteAddress: '198.51.100.2' } } });
    expect(response.status).toBe(200);
    expect(server.db.prepare('SELECT DISTINCT ip FROM submissions').all()).toEqual([{ ip: '198.51.100.2' }]);
  });

  it.each([
    ['POST', '/api/admin/submissions/batch'],
    ['GET', '/api/admin/submissions/state'],
  ])('%s %s 使用现有 Bearer 鉴权', async (method, path) => {
    const body = method === 'POST' ? '{}' : undefined;
    expect((await server.app.request(path, { method, body, headers: { 'content-type': 'application/json' } })).status).toBe(401);
    expect((await server.app.request(path, { method, body, headers: { ...admin, authorization: 'Bearer wrong' } })).status).toBe(403);
  });

  it('飞书评价在多次同步批次审核后更新原文章，不重复发布', async () => {
    const first = await submit([stationItem(), postItem]);
    await batchReview(first.batchId);
    const firstPostId = `sub-${first.results[1].id}`;
    for (const body of ['评价正文', '更新后的评价', '第三次评价']) {
      const batch = await submit([{ ...postItem, payload: { ...(postItem.payload as object), body } }]);
      await batchReview(batch.batchId);
    }
    const posts = store.all('post').filter(post => post.source === 'submission');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ id: firstPostId, body: '第三次评价' });
  });

  it('接入队列后更新旧全量导入的评价，保留原文章地址', async () => {
    expect((await send('/api/admin/import', {
      stations: [{ slug: 'sub-batch-example-com', name: '旧站点', description: '旧介绍', url: 'https://batch.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [] }],
      posts: [{ recordId: 'rec-review', stationSlug: 'sub-batch-example-com', title: '旧评价', summary: '旧摘要', body: '旧正文', authorName: '群友', publishedAt: clock().toISOString() }],
    })).status).toBe(200);
    const batch = await submit([stationItem(), postItem]);
    await batchReview(batch.batchId);
    expect(store.all('post').filter(post => post.source === 'submission')).toHaveLength(1);
    expect(store.get('post', 'feishu-rec-review')).toMatchObject({ title: '群友评价', body: '评价正文' });
  });

  it('站点网址含 www 时，聚合后的无网址评价仍关联实际物化的站点', async () => {
    const { payload } = buildBatch([
      { recordId: 'rec-www', fields: { 中转站名称: '带 www 的站点', 网址: 'https://www.example.com/', 提交类型: '推荐新站', 模型与倍率: 'GPT-4.1=0.5', 审核状态: '通过', 提交时间: '2026-11-06' } },
      { recordId: 'rec-www-review', fields: { 中转站名称: '带 www 的站点', 网址: '', 提交类型: '使用评价', 使用体验: '群友评价', 审核状态: '通过', 提交时间: '2026-11-07' } },
    ], [{ slug: 'gpt-4-1', name: 'GPT-4.1' }]);
    expect(payload.items.filter(item => item.kind === 'station')).toHaveLength(1);
    expect(payload.items[0].originKey).toBe('example.com');
    const batch = await submit(payload.items);
    await batchReview(batch.batchId);
    const station = store.all('station').find(station => station.url === 'https://www.example.com/')!;
    expect(store.get('post', `sub-${batch.results[1].id}`)).toMatchObject({ stationSlug: station.slug });
  });

  it('旧飞书站点切换 www 网址形态后仍沿用原 slug，不重复建站', async () => {
    const slug = 'sub-migration-example-com';
    expect((await send('/api/admin/import', {
      stations: [{ slug, name: '网址形态切换站', description: '旧飞书站点', url: 'https://www.migration.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [] }], posts: [],
    })).status).toBe(200);
    for (const url of ['https://migration.example.com/', 'https://www.migration.example.com/', 'https://migration.example.com/']) {
      const { payload } = buildBatch([{ recordId: 'rec-form-change', fields: {
        中转站名称: '网址形态切换站', 网址: url, 提交类型: '推荐新站', 模型与倍率: 'GPT-4.1=0.5', 审核状态: '通过', 提交时间: '2026-11-07',
      } }], [{ slug: 'gpt-4-1', name: 'GPT-4.1' }]);
      const batch = await submit(payload.items);
      await batchReview(batch.batchId);
      expect(store.all('station').filter(station => station.name === '网址形态切换站')).toHaveLength(1);
      expect(store.get('station', slug)).toMatchObject({ url, source: 'submission' });
      expect((await state()).stations).toEqual([{ slug, submissionId: batch.results[0].id, originKey: new URL(url).hostname, url, name: '网址形态切换站' }]);
    }
  });

  it.each(['feishu', 'agent'] as const)('批准 %s 裸域新版本后，同实体的 www 飞书待审版本被替代，其他渠道仍按精确 hostname', async channel => {
    const first = await submit([stationItem('www.pending-alias.example.com')], 'pending-www');
    const agent = enqueueSubmission(store, {
      ...stationItem('www.pending-alias.example.com'), channel: 'agent', ip: '127.0.0.1', now: clock(),
    });
    const unbatched = enqueueSubmission(store, {
      ...stationItem('www.pending-alias.example.com'), channel: 'feishu',
      payload: { ...(stationItem('www.pending-alias.example.com').payload as object), name: '非批次待审版本' },
      ip: '127.0.0.1', now: clock(),
    });
    const response = await send('/api/admin/submissions/batch', { channel, batchId: 'pending-bare', items: [stationItem('pending-alias.example.com')] });
    expect(response.status).toBe(200);
    const second = await response.json() as AdminBatchSubmitResponse;
    await batchReview(second.batchId);
    expect(listSubmissions(store, { batchId: first.batchId }).items[0].status).toBe('superseded');
    expect((await send(`/api/admin/submissions/${first.results[0].id}/review`, { status: 'approved' })).status).toBe(409);
    expect(listSubmissions(store, {}).items.filter(item => [agent.submission.id, unbatched.submission.id].includes(item.id))
      .map(item => item.status)).toEqual(['pending', 'pending']);
    expect(store.get('station', 'sub-pending-alias-example-com')?.url).toBe('https://pending-alias.example.com/');
  });

  it('飞书只去掉一个前导 www，不替代 www.www 与 www 的不同分组', async () => {
    const first = await submit([stationItem('www.boundary.example.com')], 'single-www');
    const second = await submit([stationItem('www.www.boundary.example.com')], 'double-www');
    await batchReview(second.batchId);
    expect(listSubmissions(store, { batchId: first.batchId }).items[0].status).toBe('pending');
    await batchReview(first.batchId);
    expect(store.all('station').filter(station => station.url?.includes('boundary.example.com')).map(station => station.url).sort())
      .toEqual(['https://www.boundary.example.com/', 'https://www.www.boundary.example.com/']);
  });

  it('Agent 更新单独的 www 实体时，不替代会认领另一裸域实体的飞书批次', async () => {
    const bare = approveStation('separate.example.com', 'agent');
    const www = approveStation('www.separate.example.com', 'agent');
    const pending = await submit([stationItem('separate.example.com')], 'separate-pending');
    const { submission } = enqueueSubmission(store, {
      ...stationItem('www.separate.example.com'), channel: 'agent',
      payload: { ...(stationItem('www.separate.example.com').payload as object), name: '更新独立 www 实体' },
      ip: '127.0.0.1', now: clock(),
    });
    reviewSubmission(store, clock(), submission.id, { status: 'approved' });
    expect(listSubmissions(store, { batchId: pending.batchId }).items[0].status).toBe('pending');
    expect(store.get('station', bare.slug)).toEqual(bare);
    expect(store.get('station', www.slug)?.name).toBe('更新独立 www 实体');
  });
});

describe('下架请求', () => {
  it('人工通过下架后站点被软删除，数据保留可恢复，入队本身不动', async () => {
    const station = approveStation();
    const batch = await submit([removalItem(station)]);
    expect(listSubmissions(store, { batchId: batch.batchId }).items[0].action).toBe('remove');
    expect(store.get('station', station.slug)).toEqual(station);
    const result = await batchReview(batch.batchId);
    expect(result.results[0].submission?.status).toBe('approved');
    // 对外读取都当作已删除。
    expect(store.get('station', station.slug)).toBeUndefined();
    expect((await state()).stations).toEqual([]);
    // 但原始行和报价还在：自动运行需要能恢复误下架的站点。
    expect(store.getWithRemoved('station', station.slug)).toEqual(station);
    expect(server.db.prepare('SELECT * FROM offers WHERE stationSlug = ?').all(station.slug).length).toBeGreaterThan(0);
    expect(store.restore('station', station.slug)).toBe(true);
    expect(store.get('station', station.slug)).toEqual(station);
  });

  it('目标已被其他操作删除时，将下架幂等地审核为 approved', async () => {
    const station = approveStation();
    const batch = await submit([removalItem(station)]);
    store.db.prepare('DELETE FROM offers WHERE stationSlug = ?').run(station.slug);
    store.db.prepare("DELETE FROM entities WHERE kind = 'station' AND id = ?").run(station.slug);
    const newer = enqueueSubmission(store, { ...stationItem(), channel: 'feishu', ip: '127.0.0.1', now: clock() }).submission;

    const response = await send(`/api/admin/submissions/${batch.results[0].id}/review`, { status: 'approved' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'approved', reason: '站点已不存在，视为已下架',
    });
    expect(listSubmissions(store, { batchId: batch.batchId }).items[0].status).toBe('approved');
    expect(listSubmissions(store, { status: 'pending' }).items.map(item => item.id)).toContain(newer.id);
  });

  it('拒绝下架只更新审核状态，站点和报价保留', async () => {
    const station = approveStation();
    const batch = await submit([removalItem(station)]);
    await batchReview(batch.batchId, 'rejected');
    expect(store.get('station', station.slug)).toEqual(station);
    expect(server.db.prepare('SELECT rate FROM offers WHERE stationSlug = ?').get(station.slug)).toEqual({ rate: 0.5 });
  });

  it('只有演示数据受下架保护，返回 409 并保留所有内容', async () => {
    const station = approveStation('protected.example.com', 'agent');
    store.transaction(() => store.put('station', station.slug, { ...station, source: 'demo' }));
    const batch = await submit([removalItem(station)]);
    const response = await send(`/api/admin/submissions/${batch.results[0].id}/review`, { status: 'approved' });
    expect(response.status).toBe(409);
    expect(store.get('station', station.slug)?.source).toBe('demo');
    expect(server.db.prepare('SELECT rate FROM offers WHERE stationSlug = ?').get(station.slug)).toEqual({ rate: 0.5 });
    expect(listSubmissions(store, { batchId: batch.batchId }).items[0].status).toBe('pending');
  });

  it.each(['agent', 'user'] as const)('source=%s 的站点可以下架，只是要经过审核', async source => {
    const station = approveStation(`removable-${source}.example.com`, 'agent');
    store.transaction(() => store.put('station', station.slug, { ...station, source }));
    const batch = await submit([removalItem(station)]);
    const result = await batchReview(batch.batchId);
    expect(result.results[0].submission?.status).toBe('approved');
    expect(store.get('station', station.slug)).toBeUndefined();
    expect(store.getWithRemoved('station', station.slug)?.source).toBe(source);
  });

  it('remove payload 缺少 slug 时单条和批次返回 400，不入队其他条目', async () => {
    const item: Item = { kind: 'station', originKey: 'batch.example.com', action: 'remove', payload: { submissionId: 'expected-version' } };
    expect((await send('/api/admin/submissions', { ...item, channel: 'feishu' })).status).toBe(400);
    const response = await send('/api/admin/submissions/batch', { channel: 'feishu', items: [stationItem('other.example.com'), item] });
    expect(response.status).toBe(400);
    expect(listSubmissions(store, {}).total).toBe(0);
  });

  it('remove payload 缺 submissionId 时单条和批次返回 400，站点保留', async () => {
    const station = approveStation();
    const item = { kind: 'station', originKey: 'batch.example.com', action: 'remove', payload: { slug: station.slug } };
    expect((await send('/api/admin/submissions', { ...item, channel: 'feishu' })).status).toBe(400);
    const response = await send('/api/admin/submissions/batch', { channel: 'feishu', items: [stationItem('other.example.com'), item] });
    expect(response.status).toBe(400);
    expect(listSubmissions(store, {}).total).toBe(1);
    expect(store.get('station', station.slug)).toEqual(station);
  });

  it.each(['feishu', 'agent'] as const)('state A 之后被 %s 更新为 B，旧 remove 审核返回 STALE_REMOVAL 并保留站点报价', async channel => {
    const first = await submit([stationItem()], 'version-a');
    await batchReview(first.batchId);
    const snapshot = (await state()).stations[0];
    expect(snapshot.submissionId).toBe(first.results[0].id);
    const response = await send('/api/admin/submissions/batch', { channel, batchId: 'version-b', items: [{
      ...stationItem(), payload: { ...(stationItem().payload as object), name: '重新收录的 B', offers: [{ modelSlug: 'gpt-4-1', rate: 0.8 }] },
    }] });
    expect(response.status).toBe(200);
    const newer = await response.json() as AdminBatchSubmitResponse;
    await batchReview(newer.batchId);
    const batch = await submit([{ kind: 'station', originKey: '伪造的 removal key', action: 'remove', payload: {
      slug: snapshot.slug, submissionId: snapshot.submissionId,
    } }]);
    const review = await send(`/api/admin/submissions/${batch.results[0].id}/review`, { status: 'approved' });
    expect(review.status).toBe(409);
    expect(await review.json()).toMatchObject({ error: { code: 'STALE_REMOVAL', message: expect.stringContaining('该站点在读取后已被更新，请重新同步') } });
    expect(store.get('station', snapshot.slug)?.name).toBe('重新收录的 B');
    expect(server.db.prepare('SELECT rate FROM offers WHERE stationSlug = ?').get(snapshot.slug)).toEqual({ rate: 0.8 });
    expect(listSubmissions(store, { batchId: batch.batchId }).items[0].status).toBe('pending');
  });

  it('www 与裸域形态切换也会阻止旧版本下架，state 给出当前实际版本', async () => {
    const first = await submit([stationItem('www.race.example.com')]);
    await batchReview(first.batchId);
    const snapshot = (await state()).stations[0];
    const second = await submit([stationItem('race.example.com')]);
    await batchReview(second.batchId);
    const current = (await state()).stations[0];
    expect(current).toMatchObject({ slug: snapshot.slug, originKey: 'race.example.com', submissionId: second.results[0].id });
    const batch = await submit([{ kind: 'station', originKey: snapshot.originKey, action: 'remove', payload: {
      slug: snapshot.slug, submissionId: first.results[0].id,
    } }]);
    const result = await batchReview(batch.batchId);
    expect(result.results[0].error).toMatchObject({ status: 409, code: 'STALE_REMOVAL' });
    expect(store.get('station', snapshot.slug)?.url).toBe('https://race.example.com/');
  });

  it('历史 pending 的非 hostname key 在通过时规范化，不能绕过当前下架版本', async () => {
    const first = await submit([stationItem()], 'legacy-key-a');
    await batchReview(first.batchId);
    const snapshot = (await state()).stations[0];
    const newer = await submit([{ ...stationItem(), payload: {
      ...(stationItem().payload as object), name: '历史待审的 B', offers: [{ modelSlug: 'gpt-4-1', rate: 0.8 }],
    } }], 'legacy-key-b');
    // 模拟规范化上线前已落库、尚未审核的客户端记录 ID。
    server.db.prepare('UPDATE submissions SET originKey = ? WHERE id = ?').run('legacy-record-id', newer.results[0].id!);
    await batchReview(newer.batchId);
    const removal = await submit([{ kind: 'station', originKey: snapshot.originKey, action: 'remove', payload: {
      slug: snapshot.slug, submissionId: snapshot.submissionId,
    } }]);
    const response = await send(`/api/admin/submissions/${removal.results[0].id}/review`, { status: 'approved' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'STALE_REMOVAL' } });
    expect(listSubmissions(store, { batchId: newer.batchId }).items[0].originKey).toBe('batch.example.com');
    expect((await state()).stations[0].submissionId).toBe(newer.results[0].id);
    expect(store.get('station', snapshot.slug)?.name).toBe('历史待审的 B');
    expect(server.db.prepare('SELECT rate FROM offers WHERE stationSlug = ?').get(snapshot.slug)).toEqual({ rate: 0.8 });
  });

  it('不存在的下架目标按幂等成功处理，记录说明原因并完成审核', async () => {
    const batch = await submit([{ kind: 'station', originKey: 'missing.example.com', action: 'remove', payload: { slug: 'sub-missing', submissionId: 'missing-version' } }]);
    const result = await batchReview(batch.batchId);
    expect(result.results[0].submission).toMatchObject({ status: 'approved', reason: '站点已不存在，视为已下架' });
    expect(listSubmissions(store, { batchId: batch.batchId }).items[0].status).toBe('approved');
  });

  it('下架后的审核写入失败时，站点、offers 和 pending 状态一起回滚', async () => {
    const station = approveStation();
    const batch = await submit([removalItem(station)]);
    const id = batch.results[0].id!;
    server.db.exec("CREATE TRIGGER fail_removal_review BEFORE UPDATE OF status ON submissions WHEN NEW.status = 'approved' BEGIN SELECT RAISE(ABORT, '审核写入失败'); END;");
    expect(() => reviewSubmission(store, clock(), id, { status: 'approved' })).toThrow('审核写入失败');
    expect(store.get('station', station.slug)).toEqual(station);
    expect(server.db.prepare('SELECT rate FROM offers WHERE stationSlug = ?').get(station.slug)).toEqual({ rate: 0.5 });
    expect(listSubmissions(store, { batchId: batch.batchId }).items[0].status).toBe('pending');
  });

  it('action 是幂等键的一部分，不能用 remove 复用相同 payload 的 upsert', async () => {
    const payload = { ...(stationItem().payload as object), slug: 'sub-batch-example-com', submissionId: 'expected-version' };
    const upsert = enqueueSubmission(store, { kind: 'station', channel: 'feishu', originKey: 'batch.example.com', payload, ip: '127.0.0.1', now: clock() });
    const removal = enqueueSubmission(store, { kind: 'station', channel: 'feishu', originKey: 'batch.example.com', action: 'remove', payload, ip: '127.0.0.1', now: clock() });
    expect(removal.submission.id).not.toBe(upsert.submission.id);
    expect(removal.deduplicated).toBe(false);
  });

  it('remove 只适用于 station，不能把模型或文章送到下架分支', async () => {
    expect((await send('/api/admin/submissions', { kind: 'post', channel: 'feishu', originKey: 'rec', action: 'remove', payload: { slug: 'sub-same' } })).status).toBe(400);
  });
});

describe('当前队列站点状态', () => {
  it('只返回已上线且 approved 的 station，包含规范化 hostname、实际 slug 和当前 submissionId', async () => {
    const approved = approveStation();
    await submit([stationItem('pending.example.com'), postItem, modelItem]);
    const rejected = await submit([stationItem('rejected.example.com')]);
    await batchReview(rejected.batchId, 'rejected');
    expect((await state()).stations).toEqual([{ slug: approved.slug, submissionId: expect.any(String), originKey: 'batch.example.com', url: 'https://batch.example.com/', name: 'batch.example.com' }]);
  });

  it('同站点多次 approved 只返回最新版本，采用服务器实际分配的碰撞 slug', async () => {
    approveStation('a.b.com');
    const station = approveStation('a-b.com');
    const updated = await submit([{ ...stationItem('a-b.com'), payload: { ...(stationItem('a-b.com').payload as object), name: '最新站名' } }]);
    await batchReview(updated.batchId);
    const stations = (await state()).stations;
    expect(stations).toHaveLength(2);
    expect(stations.find(item => item.originKey === 'a-b.com')).toEqual({ slug: station.slug, submissionId: updated.results[0].id, originKey: 'a-b.com', url: 'https://a-b.com/', name: '最新站名' });
  });

  it('飞书站点被其他渠道更新后 state 返回当前 approved id，匹配该版本可人工下架', async () => {
    const first = await submit([stationItem()]);
    await batchReview(first.batchId);
    const { submission } = enqueueSubmission(store, {
      ...stationItem(), channel: 'agent', originKey: 'another-record-id',
      payload: { ...(stationItem().payload as object), name: '其他渠道更新的当前站点' }, ip: '127.0.0.1', now: clock(),
    });
    reviewSubmission(store, clock(), submission.id, { status: 'approved' });
    const current = (await state()).stations[0];
    expect(current).toEqual({
      slug: 'sub-batch-example-com', submissionId: submission.id, originKey: 'batch.example.com',
      url: 'https://batch.example.com/', name: '其他渠道更新的当前站点',
    });
    const removal = await submit([{ kind: 'station', originKey: 'client-key', action: 'remove', payload: {
      slug: current.slug, submissionId: current.submissionId,
    } }]);
    expect((await batchReview(removal.batchId)).results[0].submission?.status).toBe('approved');
    expect(store.get('station', current.slug)).toBeUndefined();
  });

  it('旧全量导入没有 approved 投稿记录的站点不进入下架比较状态', async () => {
    const { uptime: _uptime, firstTokenLatencyMs: _latency, foundedAt: _date, status: _status, ...payload } = stationItem('legacy.example.com').payload as Record<string, unknown>;
    expect((await send('/api/admin/import', { stations: [{ ...payload, slug: 'sub-legacy-example-com' }], posts: [] })).status).toBe(200);
    expect(store.get('station', 'sub-legacy-example-com')).toBeDefined();
    expect((await state()).stations).toEqual([]);
  });

  it('其他来源的队列站点不进入飞书下架计划', async () => {
    approveStation('agent.example.com', 'agent');
    expect((await state()).stations).toEqual([]);
  });

  it('没有飞书队列记录的群友站点不会因 agent 同 hostname 投稿进入飞书状态', async () => {
    const host = 'imported.example.com';
    expect((await send('/api/admin/import', {
      stations: [{ slug: 'sub-imported-example-com', name: '旧导入站点', description: '群友站点', url: `https://${host}/`, rechargeThreshold: null, paymentMethods: [], offers: [] }], posts: [],
    })).status).toBe(200);
    const { submission } = enqueueSubmission(store, { ...stationItem(host), channel: 'agent', originKey: host, ip: '127.0.0.1', now: clock() });
    reviewSubmission(store, clock(), submission.id, { status: 'approved' });
    expect(store.get('station', 'sub-imported-example-com')?.source).toBe('submission');
    expect((await state()).stations).toEqual([]);
  });

  it.each(['agent', 'feishu'] as const)('%s 用记录 ID 提交也改存 URL hostname，仅飞书 approved 站点进入下架状态', async channel => {
    const host = 'record-key.example.com';
    const slug = 'sub-record-key-example-com';
    expect((await send('/api/admin/import', {
      stations: [{ slug, name: '渠道过渡站', description: '旧飞书站点', url: `https://${host}/`, rechargeThreshold: null, paymentMethods: [], offers: [] }], posts: [],
    })).status).toBe(200);
    const { submission } = enqueueSubmission(store, { ...stationItem(host), channel, originKey: 'old-record-1', ip: '127.0.0.1', now: clock() });
    expect(submission.originKey).toBe(host);
    reviewSubmission(store, clock(), submission.id, { status: 'approved' });
    expect(store.get('station', slug)?.source).toBe('submission');
    expect((await state()).stations).toEqual(channel === 'agent' ? [] : [{
      slug, submissionId: submission.id, originKey: host, url: `https://${host}/`, name: host,
    }]);
    const batch = await submit([stationItem(host)]);
    await batchReview(batch.batchId);
    expect((await state()).stations).toMatchObject([{ originKey: host, slug }]);
  });

  it('旧导入存在同网址的多个 slug 时，state 为每个实体返回当前版本', async () => {
    const host = 'duplicate.example.com';
    expect((await send('/api/admin/import', {
      stations: ['sub-legacy-first', 'sub-legacy-second'].map(slug => ({
        slug, name: slug, description: '旧导入站点', url: `https://${host}/`, rechargeThreshold: null, paymentMethods: [], offers: [],
      })), posts: [],
    })).status).toBe(200);
    const batch = await submit([stationItem(host)]);
    await batchReview(batch.batchId);
    expect(store.get('station', 'sub-legacy-first')?.name).toBe(host);
    expect(store.get('station', 'sub-legacy-second')?.name).toBe('sub-legacy-second');
    expect((await state()).stations).toEqual([
      { slug: 'sub-legacy-first', submissionId: batch.results[0].id, originKey: host, url: `https://${host}/`, name: host },
      { slug: 'sub-legacy-second', submissionId: batch.results[0].id, originKey: host, url: `https://${host}/`, name: 'sub-legacy-second' },
    ]);
  });

  it('遗留裸域和 www 双实体逐 slug 下架，remove 记录不会让同组实体失联', async () => {
    const host = 'foo.com';
    const wwwHost = `www.${host}`;
    expect((await send('/api/admin/import', {
      stations: [host, wwwHost].map((hostname, index) => ({
        slug: index === 0 ? 'sub-foo-com' : 'sub-www-foo-com', name: hostname,
        description: '历史飞书实体', url: `https://${hostname}/`, rechargeThreshold: null, paymentMethods: [], offers: [],
      })), posts: [],
    })).status).toBe(200);
    const upsert = await submit([stationItem(host)]);
    await batchReview(upsert.batchId);

    const snapshot = await state();
    expect(snapshot.stations.map(station => station.slug)).toEqual(['sub-foo-com', 'sub-www-foo-com']);
    expect(snapshot.stations[0].submissionId).toBe(upsert.results[0].id);
    expect(snapshot.stations[1].submissionId).toBe(upsert.results[0].id);
    const existingPlan = planBatch({ channel: 'feishu', items: [stationItem(host)] }, snapshot);
    expect(existingPlan.added).toBe(0);
    expect(existingPlan.updated).toBe(1);
    expect(existingPlan.removals).toEqual([]);

    const removalPlan = planBatch({ channel: 'feishu', items: [] }, snapshot);
    expect(removalPlan.removals.map(item => item.payload.slug)).toEqual(['sub-foo-com', 'sub-www-foo-com']);
    const removals = await submit(removalPlan.removals);
    expect(removals.results.every(result => !result.error)).toBe(true);

    const firstRemovalId = removals.results[0].id;
    if (!firstRemovalId) throw new Error('首条下架未入队');
    reviewSubmission(store, clock(), firstRemovalId, { status: 'approved' });
    expect(store.get('station', 'sub-foo-com')).toBeUndefined();
    const remaining = await state();
    expect(remaining.stations).toEqual([{
      slug: 'sub-www-foo-com', submissionId: upsert.results[0].id, originKey: wwwHost,
      url: `https://${wwwHost}/`, name: wwwHost,
    }]);
    expect(planBatch({ channel: 'feishu', items: [] }, remaining).removals.map(item => item.payload.slug)).toEqual(['sub-www-foo-com']);

    const retried = await submit(removalPlan.removals, removals.batchId);
    expect(retried.results.every(result => !result.error)).toBe(true);
    expect(retried.results[1]).toMatchObject({ id: removals.results[1].id, deduplicated: true });
    const removed = await batchReview(removals.batchId);
    expect(removed.results.every(result => result.submission?.status === 'approved')).toBe(true);
    expect(store.get('station', 'sub-foo-com')).toBeUndefined();
    expect(store.get('station', 'sub-www-foo-com')).toBeUndefined();
    expect((await state()).stations).toEqual([]);
  });
});

describe('批次自动通过', () => {
  it('开启后 upsert 即上站，下架仍 pending，继续强制 null 测量指标', async () => {
    const old = approveStation('old.example.com');
    expect((await send('/api/admin/settings', { autoApprove: true })).status).toBe(200);
    const batch = await submit([stationItem(), postItem, removalItem(old)]);
    expect(batch.results.slice(0, 2).every(item => item.autoApproved && item.status === 'approved')).toBe(true);
    expect(batch.results[2]).toMatchObject({ autoApproved: false, status: 'pending' });
    expect(store.get('station', old.slug)).toEqual(old);
    expect(server.db.prepare('SELECT rate FROM offers WHERE stationSlug = ?').get(old.slug)).toEqual({ rate: 0.5 });
    expect(store.get('station', 'sub-batch-example-com')).toMatchObject({ source: 'submission', uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null });
    expect(store.get('post', `sub-${batch.results[1].id}`)).toBeDefined();
    expect(listSubmissions(store, { batchId: batch.batchId, status: 'pending' }).total).toBe(1);
  });

  it('自动通过只作用于上架；Agent 来源的站点可以下架但要审核', async () => {
    const agentStation = approveStation('agent.example.com', 'agent');
    await send('/api/admin/settings', { autoApprove: true });
    const batch = await submit([removalItem(agentStation), stationItem()]);
    // 下架始终要审核：误删的代价比误上架大得多，自动通过只管新增和更新。
    expect(batch.results[0]).toMatchObject({ status: 'pending', autoApproved: false });
    expect(batch.results[1]).toMatchObject({ status: 'approved', autoApproved: true });
    // 但来源不是障碍：审核通过就能下线。
    expect((await batchReview(batch.batchId)).results[0].submission?.status).toBe('approved');
    expect(store.get('station', agentStation.slug)).toBeUndefined();
  });

  it('自动通过下演示数据的下架仍被拒绝', async () => {
    const demoStation = approveStation('demo.example.com', 'agent');
    store.transaction(() => store.put('station', demoStation.slug, { ...demoStation, source: 'demo' }));
    await send('/api/admin/settings', { autoApprove: true });
    const batch = await submit([removalItem(demoStation)]);
    expect(store.get('station', demoStation.slug)?.source).toBe('demo');
    expect(listSubmissions(store, { batchId: batch.batchId }).items[0].status).toBe('pending');
  });

  it('自动通过允许已下架的相同内容在新批次重新上架，且不覆盖下架前的行', async () => {
    await send('/api/admin/settings', { autoApprove: true });
    await submit([stationItem()]);
    const removal = await submit([removalItem(store.get('station', 'sub-batch-example-com')!)]);
    await batchReview(removal.batchId);
    expect(store.get('station', 'sub-batch-example-com')).toBeUndefined();
    const restored = await submit([stationItem()]);
    expect(restored.results[0]).toMatchObject({ status: 'approved', autoApproved: true });
    // 已下架的 slug 不释放：新记录走哈希后缀，下架前那行仍留在库里可恢复。
    // 否则同一 hostname 的两次上架会争用同一个 slug，后者把前者整行顶掉。
    expect(store.getWithRemoved('station', 'sub-batch-example-com')).toBeDefined();
    expect(store.all('station').filter(station => station.name === 'batch.example.com')).toHaveLength(1);
  });

  it('切换自动通过后重试 pending remove 仍复用 id 并保持待人工审', async () => {
    const old = approveStation();
    const item = removalItem(old);
    const first = await submit([item], 'pending-remove');
    await send('/api/admin/settings', { autoApprove: true });
    const repeated = await submit([item], first.batchId);
    expect(repeated.results[0]).toMatchObject({ id: first.results[0].id, status: 'pending', deduplicated: true, autoApproved: false });
    expect(store.get('station', old.slug)).toEqual(old);
    const direct = await send('/api/admin/submissions', { ...item, channel: 'feishu', batchId: first.batchId });
    expect(direct.status).toBe(200);
    expect(await direct.json()).toMatchObject({ submission: { id: first.results[0].id, status: 'pending' }, autoApproved: false });
    expect(store.get('station', old.slug)).toEqual(old);
  });

  it('开启自动通过后重试原 pending 批次，复用 id 并在同一事务物化', async () => {
    const first = await submit([stationItem(), postItem], 'switch-auto');
    await send('/api/admin/settings', { autoApprove: true });
    const repeated = await submit([stationItem(), postItem], 'switch-auto');
    expect(repeated.results.map(item => item.id)).toEqual(first.results.map(item => item.id));
    expect(repeated.results.every(item => item.status === 'approved' && item.deduplicated && item.autoApproved)).toBe(true);
    expect(store.get('station', 'sub-batch-example-com')).toBeDefined();
    expect(store.get('post', `sub-${first.results[1].id}`)).toBeDefined();
    const nextChunk = await submit([stationItem('after-switch.example.com')], first.batchId);
    expect(nextChunk.results[0]).toMatchObject({ status: 'approved', autoApproved: true });
    expect(server.db.prepare('SELECT autoApproved FROM submissions WHERE batchId = ? ORDER BY rowid').all(first.batchId))
      .toEqual([{ autoApproved: 1 }, { autoApproved: 1 }, { autoApproved: 1 }]);
  });

  it('同 batchId 中已被较新审批替代的历史内容不能误判为已生效', async () => {
    await send('/api/admin/settings', { autoApprove: true });
    await submit([stationItem()], 'same-batch');
    const changed = { ...stationItem(), payload: { ...(stationItem().payload as object), name: '第二版' } };
    await submit([changed], 'same-batch');
    expect(store.get('station', 'sub-batch-example-com')?.name).toBe('第二版');
    const restored = await submit([stationItem()], 'same-batch');
    expect(restored.results[0].autoApproved).toBe(true);
    expect(store.get('station', 'sub-batch-example-com')?.name).toBe('batch.example.com');
    const repeated = await submit([stationItem()], 'same-batch');
    expect(repeated.results[0]).toMatchObject({ id: restored.results[0].id, deduplicated: true, autoApproved: false });
  });

  it('同 batchId 自动通过 www 和裸域切换后，重提旧内容按实际站点当前版本重新物化', async () => {
    await send('/api/admin/settings', { autoApprove: true });
    const first = await submit([stationItem('www.auto-alias.example.com')], 'auto-alias');
    const slug = (await state()).stations[0].slug;
    const second = await submit([stationItem('auto-alias.example.com')], first.batchId);
    expect((await state()).stations[0]).toMatchObject({ slug, submissionId: second.results[0].id });
    const restored = await submit([stationItem('www.auto-alias.example.com')], first.batchId);
    expect(restored.results[0]).toMatchObject({ deduplicated: false, autoApproved: true });
    expect(restored.results[0].id).not.toBe(first.results[0].id);
    expect(store.get('station', slug)).toMatchObject({ name: 'www.auto-alias.example.com', url: 'https://www.auto-alias.example.com/' });
    expect((await state()).stations[0]).toMatchObject({ slug, submissionId: restored.results[0].id });
    const repeated = await submit([stationItem('www.auto-alias.example.com')], first.batchId);
    expect(repeated.results[0]).toMatchObject({ id: restored.results[0].id, deduplicated: true, autoApproved: false });
  });
});

describe('旧投稿表迁移', () => {
  it('只用 ALTER 补 batchId/action/autoApproved，保留旧数据，重复打开仍幂等并建立索引', () => {
    const directory = mkdtempSync(join(tmpdir(), 'submissions-migration-'));
    const path = join(directory, 'old.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE submissions (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, channel TEXT NOT NULL, originKey TEXT NOT NULL,
      payload TEXT NOT NULL CHECK(json_valid(payload)), payloadHash TEXT NOT NULL,
      actorHandle TEXT, ip TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
      reviewedAt TEXT, createdAt TEXT NOT NULL
    );`);
    legacy.prepare('INSERT INTO submissions (id, kind, channel, originKey, payload, payloadHash, ip, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-id', 'station', 'feishu', 'legacy.example.com', JSON.stringify(stationItem('legacy.example.com').payload), 'old-hash', '127.0.0.1', 'pending', clock().toISOString());
    legacy.prepare('INSERT INTO submissions (id, kind, channel, originKey, payload, payloadHash, ip, status, reason, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-approved', 'station', 'feishu', 'legacy.example.com', JSON.stringify(stationItem('legacy.example.com').payload), 'old-approved-hash', '127.0.0.1', 'approved', '自动通过', clock().toISOString());
    legacy.close();
    let db: DatabaseSync | undefined;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        db = openDatabase(path);
        expect(db.prepare('PRAGMA table_info(submissions)').all().map(column => column.name)).toEqual(expect.arrayContaining(['batchId', 'action', 'autoApproved']));
        expect(db.prepare('SELECT id, batchId, action, payloadHash, autoApproved FROM submissions WHERE id = ?').get('legacy-id'))
          .toEqual({ id: 'legacy-id', batchId: null, action: 'upsert', payloadHash: 'old-hash', autoApproved: 0 });
        expect(db.prepare('SELECT id, status, reason, autoApproved FROM submissions ORDER BY id').all()).toEqual([
          { id: 'legacy-approved', status: 'approved', reason: '自动通过', autoApproved: 0 },
          { id: 'legacy-id', status: 'pending', reason: null, autoApproved: 0 },
        ]);
        expect(db.prepare('PRAGMA index_info(submissions_batch)').all().map(column => column.name)).toEqual(['batchId', 'status']);
        expect(db.prepare('PRAGMA index_info(submissions_dedupe)').all().map(column => column.name)).toEqual([
          'kind', 'originKey', 'action', 'batchId', 'payloadHash', 'status', 'createdAt',
        ]);
        db.close();
        db = undefined;
      }
    } finally {
      db?.close();
      rmSync(directory, { recursive: true });
    }
  });
});

describe('下架与恢复', () => {
  it('下架后站点可以恢复，数据原样回来', async () => {
    const station = approveStation();
    const offersBefore = server.db.prepare('SELECT * FROM offers WHERE stationSlug = ? ORDER BY modelSlug').all(station.slug);
    const batch = await submit([removalItem(station)]);
    await batchReview(batch.batchId);
    expect(store.get('station', station.slug)).toBeUndefined();
    const removed = await server.app.request('/api/admin/stations/removed', { headers: admin });
    expect((await removed.json() as { items: { slug: string }[] }).items.map(item => item.slug)).toContain(station.slug);
    const restored = await server.app.request(`/api/admin/stations/${station.slug}/restore`, { method: 'POST', headers: admin });
    expect(restored.status).toBe(200);
    expect(store.get('station', station.slug)).toEqual(station);
    expect(server.db.prepare('SELECT * FROM offers WHERE stationSlug = ? ORDER BY modelSlug').all(station.slug)).toEqual(offersBefore);
  });

  it('恢复在线站点返回 409，恢复不存在的返回 404', async () => {
    const station = approveStation();
    expect((await server.app.request(`/api/admin/stations/${station.slug}/restore`, { method: 'POST', headers: admin })).status).toBe(409);
    expect((await server.app.request('/api/admin/stations/no-such-station/restore', { method: 'POST', headers: admin })).status).toBe(404);
  });
});

describe('历史数据的兼容性', () => {
  it('payload 不符合当前 schema 的历史行被跳过，而不是让整个 state 接口 400', async () => {
    // 一条缺字段的老记录就能让 /api/admin/submissions/state 整体 400，
    // 同步脚本会把它当失败中止，整条同步链路停摆且只能改库恢复。
    server.db.prepare(`INSERT INTO submissions (id, kind, channel, originKey, payload, payloadHash, actorHandle, ip, action, status, reason, reviewedAt, createdAt, autoApproved)
      VALUES ('legacy-bad', 'station', 'feishu', 'legacy.example.com', ?, 'hash', NULL, '1.2.3.4', 'upsert', 'approved', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)`)
      .run(JSON.stringify({ name: '老站', url: 'https://legacy.example.com/' }));
    const response = await server.app.request('/api/admin/submissions/state', { headers: admin });
    expect(response.status).toBe(200);
    expect((await response.json() as { stations: unknown[] }).stations).toBeInstanceOf(Array);
  });
});

describe('重跑的幂等', () => {
  it('自动通过下，相同内容在新批次里幂等命中，不产生重复行', async () => {
    await send('/api/admin/settings', { autoApprove: true });
    const first = await submit([stationItem()]);
    // 同步脚本每次用新的随机 batchId。重跑一遍不能把已成功的条目再插一遍。
    const again = await submit([stationItem()]);
    expect(again.results[0].deduplicated).toBe(true);
    expect(again.results[0].id).toBe(first.results[0].id);
    const rows = server.db.prepare("SELECT count(*) AS count FROM submissions WHERE originKey = 'batch.example.com'").get()!.count;
    expect(rows).toBe(1);
  });

  it('人工审核下，跨批次仍有待审记录时产生新行，避免一键审核漏掉', async () => {
    await send('/api/admin/settings', { autoApprove: false });
    const first = await submit([stationItem()]);
    // 人工审核态下若跨批次复用同一条 pending 行，
    // 新批次的批量审核会漏掉它（它属于旧批次），所以这里必须产生新行。
    const again = await submit([stationItem()]);
    expect(again.results[0].deduplicated).toBe(false);
    expect(again.results[0].id).not.toBe(first.results[0].id);
  });
});
