import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Post } from '@zhidedeng/shared';
import type { StationRecord, Store } from '../src/database.ts';
import { ApiError } from '../src/errors.ts';
import { createApp, openStore } from '../src/node-app.ts';
import { enqueueSubmission, listSubmissions, reviewSubmission } from '../src/submissions.ts';

const TOKEN = 'submission-admin-tests-0123456789abcdef';
const admin = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const clock = () => new Date('2026-11-07T01:00:00Z');

let server: ReturnType<typeof createApp>;
let store: Store;
beforeEach(() => {
  server = createApp({ dbPath: ':memory:', now: clock, syncToken: TOKEN });
  store = openStore(server.db);
});
afterEach(() => server.db.close());

const stationPayload = {
  name: '投稿示例站', description: '待人工核实的站点', url: 'https://api.example.com/',
  rechargeThreshold: 10, paymentMethods: ['支付宝'], offers: [{ modelSlug: 'gpt-4-1', rate: 0.5 }],
  uptime: 99.9, firstTokenLatencyMs: 123, foundedAt: '2020-01-01', status: 'running',
};
const modelPayload = { slug: 'new-submission-model', vendor: 'openai', name: '投稿模型', description: '新增模型介绍' };
const postPayload = { title: '使用评价', summary: '投稿摘要', body: '投稿正文', authorName: '投稿者甲', hostname: 'api.example.com' };
const queue = (overrides: Partial<Parameters<typeof enqueueSubmission>[1]> = {}) => enqueueSubmission(store, {
  kind: 'station', channel: 'agent', originKey: 'api.example.com', payload: stationPayload,
  ip: '127.0.0.1', now: clock(), ...overrides,
});
const approve = (id: string) => reviewSubmission(store, clock(), id, { status: 'approved' });
const record = (id: string) => listSubmissions(store, {}).items.find(item => item.id === id)!;
const entities = () => server.db.prepare('SELECT kind, id, data FROM entities ORDER BY kind, id').all();
const offers = () => server.db.prepare('SELECT modelSlug, rate FROM offers WHERE stationSlug = ? ORDER BY modelSlug').all('sub-api-example-com');
const existingStation = (source: StationRecord['source']): StationRecord => ({
  slug: 'sub-api-example-com', name: '旧站点', description: '旧描述', url: 'https://api.example.com/',
  rechargeThreshold: 20, paymentMethods: [], uptime: 98, firstTokenLatencyMs: 456,
  foundedAt: '2021-01-01', status: 'running', source,
});

describe('投稿入队与列表', () => {
  it('入队后保持 pending，列表返回 payload 和审核字段，不物化 entities', () => {
    const before = entities();
    const { submission, deduplicated } = queue({ actorHandle: 'collector' });
    expect(deduplicated).toBe(false);
    expect(submission).toMatchObject({
      kind: 'station', channel: 'agent', originKey: 'api.example.com', payload: stationPayload,
      actorHandle: 'collector', status: 'pending', reason: null, createdAt: clock().toISOString(), reviewedAt: null,
    });
    expect(listSubmissions(store, {})).toEqual({ items: [submission], total: 1, page: 1, pageSize: 20 });
    expect(submission).not.toHaveProperty('ip');
    expect(submission).not.toHaveProperty('payloadHash');
    expect(entities()).toEqual(before);
  });

  it('同 kind、originKey 和 payload 的 pending 投稿幂等，跨 channel 也不重复', () => {
    const first = queue().submission;
    const again = queue({ channel: 'feishu', actorHandle: 'another', now: new Date('2026-11-07T02:00:00Z') });
    expect(again).toEqual({ submission: first, deduplicated: true, autoApproved: false });
    expect(listSubmissions(store, {}).total).toBe(1);
  });

  it('同 hostname 的不同内容分别入队，不同 kind 或 URL hostname 互不去重', () => {
    const first = queue().submission;
    const second = queue({ payload: { ...stationPayload, name: '另一个版本' } }).submission;
    const differentKind = queue({ kind: 'post' }).submission;
    const differentOrigin = queue({ originKey: 'other.example.com', payload: { ...stationPayload, url: 'https://other.example.com/' } }).submission;
    expect(new Set([first.id, second.id, differentKind.id, differentOrigin.id]).size).toBe(4);
    expect(listSubmissions(store, { status: 'pending' }).total).toBe(4);
  });

  it('已审核的相同 payload 可重新入队，不复用旧审核结果', () => {
    const first = queue().submission;
    reviewSubmission(store, clock(), first.id, { status: 'rejected' });
    const again = queue();
    expect(again.deduplicated).toBe(false);
    expect(again.submission.id).not.toBe(first.id);
    expect(again.submission.status).toBe('pending');
  });

  it('按创建时间升序，支持 kind、status 过滤和分页', () => {
    const latest = queue({ originKey: 'latest.example.com', payload: { ...stationPayload, url: 'https://latest.example.com/' }, now: new Date('2026-11-07T03:00:00Z') }).submission;
    const oldest = queue({ originKey: 'oldest.example.com', payload: { ...stationPayload, url: 'https://oldest.example.com/' }, now: new Date('2026-11-07T01:00:00Z') }).submission;
    const middle = queue({ originKey: 'middle.example.com', payload: { ...stationPayload, url: 'https://middle.example.com/' }, now: new Date('2026-11-07T02:00:00Z') }).submission;
    const model = queue({ kind: 'model', originKey: modelPayload.slug, payload: modelPayload }).submission;
    reviewSubmission(store, clock(), model.id, { status: 'rejected' });
    expect(listSubmissions(store, { kind: 'station', status: 'pending', page: 2, pageSize: 1 }))
      .toEqual({ items: [middle], total: 3, page: 2, pageSize: 1 });
    expect(listSubmissions(store, { kind: 'station' }).items.map(item => item.id)).toEqual([oldest.id, middle.id, latest.id]);
    expect(listSubmissions(store, { status: 'rejected' }).items.map(item => item.id)).toEqual([model.id]);
  });

  it.each([undefined, 1n])('拒绝不能存成 JSON 的 payload %s，不留下记录', payload => {
    expect(() => queue({ payload })).toThrow(expect.objectContaining({ status: 400, code: 'INVALID_INPUT' }));
    expect(listSubmissions(store, {}).total).toBe(0);
  });
});

describe('审核物化', () => {
  it.each([
    ['agent', 'agent'], ['feishu', 'submission'], ['web', 'user'],
  ] as const)('%s 站点通过后映射为 %s，报价入库，测量字段强制为空', (channel, source) => {
    const submission = queue({ channel }).submission;
    expect(approve(submission.id)).toMatchObject({ id: submission.id, status: 'approved', reviewedAt: clock().toISOString() });
    expect(store.get('station', 'sub-api-example-com')).toMatchObject({
      name: '投稿示例站', source, uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null,
    });
    expect(offers()).toEqual([{ modelSlug: 'gpt-4-1', rate: 0.5 }]);
  });

  it.each(['demo', 'submission', 'agent', 'user'] as const)('slug 已存在时更新内容和全部报价，保留原 source=%s', source => {
    store.put('station', 'sub-api-example-com', existingStation(source));
    server.db.prepare('INSERT INTO offers (stationSlug, modelSlug, rate) VALUES (?, ?, ?)').run('sub-api-example-com', 'o3', 0.7);
    const submission = queue({ payload: { ...stationPayload, name: '更新站名', description: '更新描述' } }).submission;
    approve(submission.id);
    expect(store.get('station', 'sub-api-example-com')).toMatchObject({
      name: '更新站名', description: '更新描述', source, uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null,
    });
    expect(offers()).toEqual([{ modelSlug: 'gpt-4-1', rate: 0.5 }]);
  });

  it('station slug 转小写并合并连续连字符', () => {
    const submission = queue({ originKey: 'API--Example.COM', payload: { ...stationPayload, url: 'https://api--example.com/' } }).submission;
    approve(submission.id);
    expect(store.get('station', 'sub-api-example-com')?.name).toBe('投稿示例站');
  });

  it('超长 hostname 的 slug 不超过 100 字符，带哈希后缀以免截断后撞车', () => {
    const originKey = `${'a'.repeat(63)}.${'b'.repeat(63)}.com`;
    const submission = queue({ originKey, payload: { ...stationPayload, url: `https://${originKey}/` } }).submission;
    approve(submission.id);
    const station = store.all('station').find(item => item.name === stationPayload.name)!;
    expect(station.slug.length).toBeLessThanOrEqual(100);
    // 纯截断会让两个前缀相同的长域名共用 slug，所以尾部必须是由 hostname 派生的哈希
    expect(station.slug).toMatch(/-[0-9a-f]{8,}$/);
    expect(station.slug.startsWith(`sub-${'a'.repeat(63)}`)).toBe(true);
  });

  it.each([0.05, 20])('沿用现有倍率校验，接受边界 %s', rate => {
    const submission = queue({ payload: { ...stationPayload, offers: [{ modelSlug: 'o3', rate }] } }).submission;
    approve(submission.id);
    expect(offers()).toEqual([{ modelSlug: 'o3', rate }]);
  });

  it.each([
    ['倍率低于范围', { ...stationPayload, offers: [{ modelSlug: 'o3', rate: 0.04 }] }],
    ['倍率为零', { ...stationPayload, offers: [{ modelSlug: 'o3', rate: 0 }] }],
    ['倍率为负数', { ...stationPayload, offers: [{ modelSlug: 'o3', rate: -1 }] }],
    ['倍率高于范围', { ...stationPayload, offers: [{ modelSlug: 'o3', rate: 20.01 }] }],
    ['未知模型', { ...stationPayload, offers: [{ modelSlug: 'missing-model', rate: 0.5 }] }],
    ['重复报价', { ...stationPayload, offers: [stationPayload.offers[0], stationPayload.offers[0]] }],
  ])('拒绝%s，投稿仍 pending，旧站点和报价不变', (_name, payload) => {
    store.put('station', 'sub-api-example-com', existingStation('submission'));
    server.db.prepare('INSERT INTO offers (stationSlug, modelSlug, rate) VALUES (?, ?, ?)').run('sub-api-example-com', 'o3', 0.7);
    const before = entities();
    const previousOffers = offers();
    const submission = queue({ payload }).submission;
    expect(() => approve(submission.id)).toThrow(expect.objectContaining({ status: 400, code: 'INVALID_INPUT' }));
    expect(record(submission.id)).toEqual(submission);
    expect(entities()).toEqual(before);
    expect(offers()).toEqual(previousOffers);
  });

  it.each([
    ['非 HTTP URL', 'javascript:alert(1)'],
    ['URL 带 query', 'https://api.example.com/?aff=1'],
    ['URL 带 fragment', 'https://api.example.com/#aff'],
    ['URL 带凭证', 'https://user:pass@api.example.com/'],
  ])('入队前拒绝%s，不能规范化的内容不留下记录或改写旧站点', (_name, url) => {
    store.put('station', 'sub-api-example-com', existingStation('submission'));
    server.db.prepare('INSERT INTO offers (stationSlug, modelSlug, rate) VALUES (?, ?, ?)').run('sub-api-example-com', 'o3', 0.7);
    const before = entities();
    const previousOffers = offers();
    expect(() => queue({ payload: { ...stationPayload, url } })).toThrow(expect.objectContaining({ status: 400, code: 'INVALID_INPUT' }));
    expect(listSubmissions(store, {}).total).toBe(0);
    expect(entities()).toEqual(before);
    expect(offers()).toEqual(previousOffers);
  });

  it('model 通过后入库，覆盖传入 tags 为空数组', () => {
    const submission = queue({ kind: 'model', originKey: modelPayload.slug, payload: { ...modelPayload, tags: ['不采信的标签'] } }).submission;
    approve(submission.id);
    expect(store.get('model', modelPayload.slug)).toEqual({ ...modelPayload, tags: [] });
  });

  it('model 的厂商不存在时返回可定位错误，投稿仍 pending，entities 不变', () => {
    const before = entities();
    const submission = queue({ kind: 'model', originKey: modelPayload.slug, payload: { ...modelPayload, vendor: 'missing-vendor' } }).submission;
    expect(() => approve(submission.id)).toThrow(expect.objectContaining({
      status: 400, code: 'INVALID_INPUT', message: '厂商 missing-vendor 不存在，请先新增厂商',
    }));
    expect(record(submission.id)).toEqual(submission);
    expect(entities()).toEqual(before);
    expect(store.get('model', modelPayload.slug)).toBeUndefined();
  });

  it.each([
    ['agent', 'agent'], ['feishu', 'submission'], ['web', 'user'],
  ] as const)('%s 文章通过后 source=%s，按 hostname 找到已有的任意 station slug', async (channel, source) => {
    store.put('station', 'legacy-station', { ...existingStation('submission'), slug: 'legacy-station' });
    const submission = queue({ kind: 'post', channel, originKey: 'rec001', payload: { ...postPayload, publishedAt: '2026-11-06T08:00:00.000Z' } }).submission;
    approve(submission.id);
    const id = `sub-${submission.id}`;
    expect(store.get('post', id)).toMatchObject({
      id, kind: 'review', status: 'approved', source, authorHandle: 'anonymous-submission', authorNickname: '投稿者甲',
      stationSlug: 'legacy-station', modelSlug: null, cover: null, publishedAt: '2026-11-06T08:00:00.000Z',
    });
    const response = await server.app.request(`/api/posts/${id}`);
    expect(response.status).toBe(200);
    expect(await response.json() as Post).toMatchObject({ source, author: { handle: 'anonymous-submission', nickname: '投稿者甲' } });
  });

  it('文章站点不存在时关联为 null，保留 authorHandle，缺少时间时使用审核时间', () => {
    const submission = queue({ kind: 'post', originKey: 'local-post', payload: { ...postPayload, authorHandle: 'collector' } }).submission;
    approve(submission.id);
    expect(store.get('post', `sub-${submission.id}`)).toMatchObject({
      stationSlug: null, authorHandle: 'collector', publishedAt: clock().toISOString(),
    });
  });

  it('物化文章时保留正文和摘要的原始空白', () => {
    const submission = queue({ kind: 'post', originKey: 'local-post', payload: {
      ...postPayload, summary: '  投稿摘要  ', body: '  第一行\n\n第二行  ',
    } }).submission;
    approve(submission.id);
    expect(store.get('post', `sub-${submission.id}`)).toMatchObject({ summary: '  投稿摘要  ', body: '  第一行\n\n第二行  ' });
  });

  it('rejected 只更新审核状态、理由和时间，不改 entities 或其他 pending', () => {
    const before = entities();
    const submission = queue().submission;
    const other = queue({ payload: { ...stationPayload, name: '另一个版本' } }).submission;
    expect(reviewSubmission(store, clock(), submission.id, { status: 'rejected', reason: '材料不足' })).toMatchObject({
      id: submission.id, status: 'rejected', reason: '材料不足', reviewedAt: clock().toISOString(),
    });
    expect(entities()).toEqual(before);
    expect(record(other.id).status).toBe('pending');
  });

  it.each(['approved', 'rejected'] as const)('%s 后重复审核返回 409 ALREADY_REVIEWED', status => {
    const submission = queue().submission;
    reviewSubmission(store, clock(), submission.id, { status });
    expect(() => approve(submission.id)).toThrow(expect.objectContaining({ status: 409, code: 'ALREADY_REVIEWED' }));
  });

  it('找不到投稿返回 404 NOT_FOUND', () => {
    expect(() => approve('missing-id')).toThrow(expect.objectContaining({ status: 404, code: 'NOT_FOUND' }));
  });

  it('通过后仅将同 kind、originKey 的其他 pending 标为 superseded，跨 channel 生效', () => {
    const first = queue().submission;
    const second = queue({ channel: 'feishu', payload: { ...stationPayload, name: '第二版' } }).submission;
    const otherKind = queue({ kind: 'post' }).submission;
    const otherOrigin = queue({ originKey: 'other.example.com', payload: { ...stationPayload, url: 'https://other.example.com/' } }).submission;
    approve(first.id);
    expect(record(second.id).status).toBe('superseded');
    expect(record(otherKind.id).status).toBe('pending');
    expect(record(otherOrigin.id).status).toBe('pending');
    expect(() => approve(second.id)).toThrow(expect.objectContaining({ status: 409, code: 'ALREADY_REVIEWED' }));
  });

  it('superseded 更新失败时回滚 station、offers 和已批准状态', () => {
    store.put('station', 'sub-api-example-com', existingStation('submission'));
    server.db.prepare('INSERT INTO offers (stationSlug, modelSlug, rate) VALUES (?, ?, ?)').run('sub-api-example-com', 'o3', 0.7);
    const before = entities();
    const previousOffers = offers();
    const first = queue().submission;
    const second = queue({ payload: { ...stationPayload, name: '第二版' } }).submission;
    server.db.exec("CREATE TRIGGER fail_superseded BEFORE UPDATE OF status ON submissions WHEN NEW.status = 'superseded' BEGIN SELECT RAISE(ABORT, '审核写入失败'); END;");
    expect(() => approve(first.id)).toThrow('审核写入失败');
    expect(record(first.id)).toEqual(first);
    expect(record(second.id)).toEqual(second);
    expect(entities()).toEqual(before);
    expect(offers()).toEqual(previousOffers);
  });
});

describe('投稿管理接口', () => {
  it('待审队列默认返回第一页，空队列总数为零', async () => {
    const response = await server.app.request('/api/admin/submissions', { headers: admin });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('默认只列 pending，显式 status、kind 和分页参数生效', async () => {
    const first = queue().submission;
    const second = queue({ payload: { ...stationPayload, name: '第二版' } }).submission;
    reviewSubmission(store, clock(), first.id, { status: 'rejected' });
    const response = await server.app.request('/api/admin/submissions', { headers: admin });
    expect(await response.json()).toMatchObject({ total: 1, items: [{ id: second.id, status: 'pending' }] });
    const filtered = await server.app.request('/api/admin/submissions?status=rejected&kind=station&page=1&pageSize=1', { headers: admin });
    expect(await filtered.json()).toMatchObject({ total: 1, page: 1, pageSize: 1, items: [{ id: first.id }] });
  });

  it('单条审核返回结果及缺失、重复审核错误', async () => {
    const submission = queue().submission;
    const review = (id: string) => server.app.request(`/api/admin/submissions/${id}/review`, {
      method: 'POST', headers: admin, body: JSON.stringify({ status: 'approved', reason: '已检查材料' }),
    });
    const approved = await review(submission.id);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ id: submission.id, status: 'approved', reason: '已检查材料' });
    const again = await review(submission.id);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'ALREADY_REVIEWED' } });
    expect((await review('missing-id')).status).toBe(404);
  });

  it('批量审核一条失败不影响其他，逐条返回错误和成功结果', async () => {
    const invalid = queue({ kind: 'model', originKey: modelPayload.slug, payload: { ...modelPayload, vendor: 'missing-vendor' } }).submission;
    const valid = queue().submission;
    const response = await server.app.request('/api/admin/submissions/batch-review', {
      method: 'POST', headers: admin, body: JSON.stringify({ ids: [invalid.id, 'missing-id', valid.id], status: 'approved' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [
      { id: invalid.id, error: { status: 400, code: 'INVALID_INPUT' } },
      { id: 'missing-id', error: { status: 404, code: 'NOT_FOUND' } },
      { id: valid.id, submission: { id: valid.id, status: 'approved' } },
    ] });
    expect(record(invalid.id).status).toBe('pending');
    expect(record(valid.id).status).toBe('approved');
    expect(store.get('station', 'sub-api-example-com')).toBeDefined();
  });

  it.each([
    ['GET', '/api/admin/submissions'],
    ['POST', '/api/admin/submissions/missing-id/review'],
    ['POST', '/api/admin/submissions/batch-review'],
  ])('%s %s 沿用 Bearer 鉴权：无 token 401，错 token 403', async (method, path) => {
    const init = { method, ...(method === 'POST' ? { body: '{}' } : {}) };
    expect((await server.app.request(path, { ...init, headers: { 'content-type': 'application/json' } })).status).toBe(401);
    expect((await server.app.request(path, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' } })).status).toBe(403);
  });

  it.each(['status=unknown', 'kind=vendor', 'page=0', 'pageSize=0'])('拒绝非法列表参数 %s', async query => {
    const response = await server.app.request(`/api/admin/submissions?${query}`, { headers: admin });
    expect(response.status).toBe(400);
  });

  it.each([
    { status: 'pending' }, { status: 'approved', reason: 123 }, { ids: [], status: 'approved' },
  ])('拒绝非法批量审核正文 %j', async body => {
    const response = await server.app.request('/api/admin/submissions/batch-review', { method: 'POST', headers: admin, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
  });
});
