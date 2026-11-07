import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminBatchSubmitRequest, AdminBatchSubmitResponse, AdminSubmissionStateResponse, SubmissionRecord } from '@zhidedeng/shared';
import type { Store } from '../src/database.ts';
import { createApp, openDatabase, openStore } from '../src/node-app.ts';
import { enqueueSubmission, listSubmissions, reviewSubmission } from '../src/submissions.ts';
import { buildBatch } from '../../scripts/sync-feishu.ts';

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

describe('批次入队与审核', () => {
  it('服务端生成统一 batchId，逐条返回结果并沿用 pending 幂等', async () => {
    const result = await submit([stationItem(), stationItem(), postItem]);
    expect(result.batchId).toBeTruthy();
    expect(result.results).toMatchObject([
      { originKey: 'batch.example.com', kind: 'station', status: 'pending', deduplicated: false, autoApproved: false },
      { originKey: 'batch.example.com', kind: 'station', status: 'pending', deduplicated: true, autoApproved: false },
      { originKey: 'rec-review', kind: 'post', status: 'pending', deduplicated: false, autoApproved: false },
    ]);
    expect(result.results[1].id).toBe(result.results[0].id);
    expect(listSubmissions(store, {}).items).toHaveLength(2);
    expect(listSubmissions(store, {}).items.every(item => item.batchId === result.batchId && item.action === 'upsert')).toBe(true);
    expect(store.all('station').find(station => station.name === 'batch.example.com')).toBeUndefined();
  });

  it('列表按 batchId 过滤，重复请求同一批次不重复入队', async () => {
    const first = await submit([stationItem()], 'batch-one');
    await submit([stationItem('other.example.com')], 'batch-two');
    const repeated = await submit([stationItem()], 'batch-one');
    expect(repeated.results[0]).toMatchObject({ id: first.results[0].id, deduplicated: true });
    const response = await server.app.request('/api/admin/submissions?batchId=batch-one', { headers: admin });
    expect(await response.json()).toMatchObject({ total: 1, items: [{ id: first.results[0].id, batchId: 'batch-one' }] });
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
    const result = await submit([{ ...stationItem(), payload: {} }, stationItem('good.example.com')]);
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
      expect((await state()).stations).toEqual([{ slug, originKey: 'migration.example.com', url, name: '网址形态切换站' }]);
    }
  });
});

describe('下架请求', () => {
  it('人工通过下架后删除站点和全部 offers，入队本身不删除', async () => {
    const station = approveStation();
    const batch = await submit([{ kind: 'station', originKey: 'batch.example.com', action: 'remove', payload: { slug: station.slug } }]);
    expect(listSubmissions(store, { batchId: batch.batchId }).items[0].action).toBe('remove');
    expect(store.get('station', station.slug)).toEqual(station);
    const result = await batchReview(batch.batchId);
    expect(result.results[0].submission?.status).toBe('approved');
    expect(store.get('station', station.slug)).toBeUndefined();
    expect(server.db.prepare('SELECT * FROM offers WHERE stationSlug = ?').all(station.slug)).toEqual([]);
    expect((await state()).stations).toEqual([]);
  });

  it('拒绝下架只更新审核状态，站点和报价保留', async () => {
    const station = approveStation();
    const batch = await submit([{ kind: 'station', originKey: 'batch.example.com', action: 'remove', payload: { slug: station.slug } }]);
    await batchReview(batch.batchId, 'rejected');
    expect(store.get('station', station.slug)).toEqual(station);
    expect(server.db.prepare('SELECT rate FROM offers WHERE stationSlug = ?').get(station.slug)).toEqual({ rate: 0.5 });
  });

  it.each(['agent', 'demo', 'user'] as const)('不能下架 source=%s 的站点，返回 409 并保留所有内容', async source => {
    const station = approveStation('protected.example.com', 'agent');
    store.transaction(() => store.put('station', station.slug, { ...station, source }));
    const batch = await submit([{ kind: 'station', originKey: 'protected.example.com', action: 'remove', payload: { slug: station.slug } }]);
    const response = await send(`/api/admin/submissions/${batch.results[0].id}/review`, { status: 'approved' });
    expect(response.status).toBe(409);
    expect(store.get('station', station.slug)?.source).toBe(source);
    expect(server.db.prepare('SELECT rate FROM offers WHERE stationSlug = ?').get(station.slug)).toEqual({ rate: 0.5 });
    expect(listSubmissions(store, { batchId: batch.batchId }).items[0].status).toBe('pending');
  });

  it('remove payload 缺少 slug 时单条入口返回 400，批次逐条报错', async () => {
    const item: Item = { kind: 'station', originKey: 'batch.example.com', action: 'remove', payload: {} };
    expect((await send('/api/admin/submissions', { ...item, channel: 'feishu' })).status).toBe(400);
    const batch = await submit([item, stationItem('other.example.com')]);
    expect(batch.results[0].error?.code).toBe('INVALID_INPUT');
    expect(batch.results[1].status).toBe('pending');
    expect(listSubmissions(store, {}).total).toBe(1);
  });

  it('不存在的下架目标返回 404，不把请求伪装为已生效', async () => {
    const batch = await submit([{ kind: 'station', originKey: 'missing.example.com', action: 'remove', payload: { slug: 'sub-missing' } }]);
    const result = await batchReview(batch.batchId);
    expect(result.results[0].error).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(listSubmissions(store, { batchId: batch.batchId }).items[0].status).toBe('pending');
  });

  it('下架后的审核写入失败时，站点、offers 和 pending 状态一起回滚', async () => {
    const station = approveStation();
    const batch = await submit([{ kind: 'station', originKey: 'batch.example.com', action: 'remove', payload: { slug: station.slug } }]);
    const id = batch.results[0].id!;
    server.db.exec("CREATE TRIGGER fail_removal_review BEFORE UPDATE OF status ON submissions WHEN NEW.status = 'approved' BEGIN SELECT RAISE(ABORT, '审核写入失败'); END;");
    expect(() => reviewSubmission(store, clock(), id, { status: 'approved' })).toThrow('审核写入失败');
    expect(store.get('station', station.slug)).toEqual(station);
    expect(server.db.prepare('SELECT rate FROM offers WHERE stationSlug = ?').get(station.slug)).toEqual({ rate: 0.5 });
    expect(listSubmissions(store, { batchId: batch.batchId }).items[0].status).toBe('pending');
  });

  it('action 是幂等键的一部分，不能用 remove 复用相同 payload 的 upsert', async () => {
    const upsert = enqueueSubmission(store, { kind: 'station', channel: 'feishu', originKey: 'same', payload: { slug: 'sub-same' }, ip: '127.0.0.1', now: clock() });
    const removal = enqueueSubmission(store, { kind: 'station', channel: 'feishu', originKey: 'same', action: 'remove', payload: { slug: 'sub-same' }, ip: '127.0.0.1', now: clock() });
    expect(removal.submission.id).not.toBe(upsert.submission.id);
    expect(removal.deduplicated).toBe(false);
  });

  it('remove 只适用于 station，不能把模型或文章送到下架分支', async () => {
    expect((await send('/api/admin/submissions', { kind: 'post', channel: 'feishu', originKey: 'rec', action: 'remove', payload: { slug: 'sub-same' } })).status).toBe(400);
  });
});

describe('当前队列站点状态', () => {
  it('只返回已上线且 approved 的 station，包含原 originKey、实际 slug 和 payload 的 url/name', async () => {
    const approved = approveStation();
    await submit([stationItem('pending.example.com'), postItem, modelItem]);
    const rejected = await submit([stationItem('rejected.example.com')]);
    await batchReview(rejected.batchId, 'rejected');
    expect((await state()).stations).toEqual([{ slug: approved.slug, originKey: 'batch.example.com', url: 'https://batch.example.com/', name: 'batch.example.com' }]);
  });

  it('同站点多次 approved 只返回最新版本，采用服务器实际分配的碰撞 slug', async () => {
    approveStation('a.b.com');
    const station = approveStation('a-b.com');
    const updated = await submit([{ ...stationItem('a-b.com'), payload: { ...(stationItem('a-b.com').payload as object), name: '最新站名' } }]);
    await batchReview(updated.batchId);
    const stations = (await state()).stations;
    expect(stations).toHaveLength(2);
    expect(stations.find(item => item.originKey === 'a-b.com')).toEqual({ slug: station.slug, originKey: 'a-b.com', url: 'https://a-b.com/', name: '最新站名' });
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

  it.each(['agent', 'feishu'] as const)('%s 用记录 ID 更新旧群友站点后，该 ID 不进入飞书 hostname 下架状态', async channel => {
    const host = 'record-key.example.com';
    const slug = 'sub-record-key-example-com';
    expect((await send('/api/admin/import', {
      stations: [{ slug, name: '渠道过渡站', description: '旧飞书站点', url: `https://${host}/`, rechargeThreshold: null, paymentMethods: [], offers: [] }], posts: [],
    })).status).toBe(200);
    const { submission } = enqueueSubmission(store, { ...stationItem(host), channel, originKey: 'old-record-1', ip: '127.0.0.1', now: clock() });
    reviewSubmission(store, clock(), submission.id, { status: 'approved' });
    expect(store.get('station', slug)?.source).toBe('submission');
    expect((await state()).stations).toEqual([]);
    const batch = await submit([stationItem(host)]);
    await batchReview(batch.batchId);
    expect((await state()).stations).toMatchObject([{ originKey: host, slug }]);
  });

  it('旧导入存在同网址的多个 slug 时，state 只返回实际被队列更新的首个站点', async () => {
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
    expect((await state()).stations).toEqual([{ slug: 'sub-legacy-first', originKey: host, url: `https://${host}/`, name: host }]);
  });
});

describe('批次自动通过', () => {
  it('开启后整批即上站，下架立即生效，仍强制 null 测量指标', async () => {
    const old = approveStation('old.example.com');
    expect((await send('/api/admin/settings', { autoApprove: true })).status).toBe(200);
    const batch = await submit([stationItem(), postItem, { kind: 'station', originKey: 'old.example.com', action: 'remove', payload: { slug: old.slug } }]);
    expect(batch.results.every(item => item.autoApproved && item.status === 'approved')).toBe(true);
    expect(store.get('station', old.slug)).toBeUndefined();
    expect(server.db.prepare('SELECT * FROM offers WHERE stationSlug = ?').all(old.slug)).toEqual([]);
    expect(store.get('station', 'sub-batch-example-com')).toMatchObject({ source: 'submission', uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null });
    expect(store.get('post', `sub-${batch.results[1].id}`)).toBeDefined();
    expect(listSubmissions(store, { batchId: batch.batchId, status: 'pending' }).total).toBe(0);
  });

  it('自动通过失败只回滚该条，不留下 approved 幽灵，其余条目仍生效', async () => {
    const protectedStation = approveStation('agent.example.com', 'agent');
    await send('/api/admin/settings', { autoApprove: true });
    const batch = await submit([{ kind: 'station', originKey: 'agent.example.com', action: 'remove', payload: { slug: protectedStation.slug } }, stationItem()]);
    expect(batch.results[0].error).toBeDefined();
    expect(batch.results[1]).toMatchObject({ status: 'approved', autoApproved: true });
    expect(store.get('station', protectedStation.slug)?.source).toBe('agent');
    expect(listSubmissions(store, { batchId: batch.batchId }).total).toBe(1);
  });

  it('自动通过允许已下架的相同内容在新批次重新上架', async () => {
    await send('/api/admin/settings', { autoApprove: true });
    await submit([stationItem()]);
    await submit([{ kind: 'station', originKey: 'batch.example.com', action: 'remove', payload: { slug: 'sub-batch-example-com' } }]);
    expect(store.get('station', 'sub-batch-example-com')).toBeUndefined();
    const restored = await submit([stationItem()]);
    expect(restored.results[0]).toMatchObject({ status: 'approved', autoApproved: true });
    expect(store.get('station', 'sub-batch-example-com')).toBeDefined();
  });

  it('开启自动通过后重试原 pending 批次，复用 id 并在同一事务物化', async () => {
    const first = await submit([stationItem(), postItem], 'switch-auto');
    await send('/api/admin/settings', { autoApprove: true });
    const repeated = await submit([stationItem(), postItem], 'switch-auto');
    expect(repeated.results.map(item => item.id)).toEqual(first.results.map(item => item.id));
    expect(repeated.results.every(item => item.status === 'approved' && item.deduplicated && item.autoApproved)).toBe(true);
    expect(store.get('station', 'sub-batch-example-com')).toBeDefined();
    expect(store.get('post', `sub-${first.results[1].id}`)).toBeDefined();
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
});

describe('旧投稿表迁移', () => {
  it('只用 ALTER 补 batchId/action，保留旧数据，重复打开仍幂等并建立索引', () => {
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
    legacy.close();
    let db: DatabaseSync | undefined;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        db = openDatabase(path);
        expect(db.prepare('PRAGMA table_info(submissions)').all().map(column => column.name)).toEqual(expect.arrayContaining(['batchId', 'action']));
        expect(db.prepare('SELECT id, batchId, action, payloadHash FROM submissions').get()).toEqual({ id: 'legacy-id', batchId: null, action: 'upsert', payloadHash: 'old-hash' });
        expect(db.prepare('PRAGMA index_info(submissions_batch)').all().map(column => column.name)).toEqual(['batchId', 'status']);
        db.close();
        db = undefined;
      }
    } finally {
      db?.close();
      rmSync(directory, { recursive: true });
    }
  });
});
