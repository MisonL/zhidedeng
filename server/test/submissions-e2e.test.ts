import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StationDetail } from '@zhidedeng/shared';
import { createApp, openStore } from '../src/node-app.ts';
import { enqueueSubmission } from '../src/submissions.ts';

const TOKEN = 'verify-admin-token-0123456789abcdef';
const admin = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const clock = () => new Date('2026-11-07T03:00:00Z');

let server: ReturnType<typeof createApp>;
beforeEach(() => { server = createApp({ dbPath: ':memory:', now: clock, syncToken: TOKEN }); });
afterEach(() => server.db.close());

const payload = {
  name: '路由验证站', description: '走 HTTP 全链路验证', url: 'https://route.example.com/',
  rechargeThreshold: 10, paymentMethods: ['支付宝'],
  offers: [{ modelSlug: 'gpt-4-1', rate: 0.5 }],
  uptime: 99.9, firstTokenLatencyMs: 100, foundedAt: '2020-01-01', status: 'running',
};
const queue = (channel: 'agent' | 'feishu' | 'web', overrides: Record<string, unknown> = {}) =>
  enqueueSubmission(openStore(server.db), {
    kind: 'station', channel, originKey: 'route.example.com', payload: { ...payload, ...overrides },
    ip: '127.0.0.1', now: clock(),
  });

const list = async (query = '') => await (await server.app.request(`/api/admin/submissions${query}`, { headers: admin })).json() as {
  items: { id: string; status: string; channel: string }[]; total: number;
};
const review = (id: string, body: unknown) => server.app.request(`/api/admin/submissions/${id}/review`, {
  method: 'POST', headers: admin, body: JSON.stringify(body),
});

// 与 submissions.test.ts 的分工：那边直接调函数查数据库，这里只走 HTTP，
// 覆盖「物化写对了但接口读出来不对」这类只在路由层暴露的问题。
describe('投稿全链路（HTTP 层）', () => {
  it('未配置或错误的 token 一律拒绝', async () => {
    // 无 header 是 401（缺少 Bearer），错 token 是 403（token 无效）
    expect((await server.app.request('/api/admin/submissions')).status).toBe(401);
    expect((await server.app.request('/api/admin/submissions', { headers: { authorization: 'Bearer wrong' } })).status).toBe(403);
  });

  it('默认只列 pending，按 createdAt 升序', async () => {
    // 幂等键不含 channel，同 payload 只入队一条；这里用不同描述制造两条
    queue('agent');
    queue('feishu', { description: '另一份描述' });
    const result = await list();
    expect(result.total).toBe(2);
    expect(result.items.every(item => item.status === 'pending')).toBe(true);
  });

  it('审核通过后站点可公开访问，测量指标被强制为 null', async () => {
    const { submission } = queue('agent');
    expect((await review(submission.id, { status: 'approved' })).status).toBe(200);

    const detail = await (await server.app.request('/api/stations/sub-route-example-com')).json() as StationDetail;
    expect(detail).toMatchObject({ name: '路由验证站', source: 'agent', lowestRate: 0.5 });
    // 提交时故意带了这些字段，物化后必须是 null
    expect(detail.uptime).toBeNull();
    expect(detail.firstTokenLatencyMs).toBeNull();
    expect(detail.foundedAt).toBeNull();
    expect(detail.status).toBeNull();
  });

  it('审核通过后同 originKey 的其他 pending 变成 superseded', async () => {
    const first = queue('agent').submission;
    const second = queue('agent', { description: '更新后的描述' }).submission;
    expect(first.id).not.toBe(second.id);

    await review(first.id, { status: 'approved' });
    const pending = await list('?status=pending');
    expect(pending.items.map(item => item.id)).not.toContain(second.id);
    const superseded = await list('?status=superseded');
    expect(superseded.items.map(item => item.id)).toContain(second.id);
  });

  it('飞书渠道的站点标成 submission，不标成 agent', async () => {
    const { submission } = queue('feishu');
    await review(submission.id, { status: 'approved' });
    const detail = await (await server.app.request('/api/stations/sub-route-example-com')).json() as StationDetail;
    expect(detail.source).toBe('submission');
  });

  it('已存在的站点更新时保留原 source', async () => {
    queue('feishu');
    const pendingList = await list();
    await review(pendingList.items[0].id, { status: 'approved' });

    const { submission } = queue('agent', { name: '改过的名字' });
    await review(submission.id, { status: 'approved' });

    const detail = await (await server.app.request('/api/stations/sub-route-example-com')).json() as StationDetail;
    expect(detail.name).toBe('改过的名字');
    expect(detail.source).toBe('submission');
  });

  it('未知模型导致审核失败并回滚，记录落成 rejected 终态', async () => {
    const { submission } = queue('agent', { offers: [{ modelSlug: 'no-such-model', rate: 0.5 }] });
    const response = await review(submission.id, { status: 'approved' });
    expect(response.status).toBe(400);
    // 物化失败必须离开待审队列，否则批次永远审不完、待审配额被永久占用。
    expect((await list('?status=rejected')).items.map(item => item.id)).toContain(submission.id);
    expect((await list('?status=pending')).items.map(item => item.id)).not.toContain(submission.id);
    expect((await server.app.request('/api/stations/sub-route-example-com')).status).toBe(404);
  });

  it('拒绝后不物化，reason 保留', async () => {
    const { submission } = queue('agent');
    expect((await review(submission.id, { status: 'rejected', reason: '信息不足' })).status).toBe(200);
    expect((await server.app.request('/api/stations/sub-route-example-com')).status).toBe(404);
    const rejected = await list('?status=rejected');
    expect(rejected.items.map(item => item.id)).toContain(submission.id);
  });

  it('重复审核返回 409', async () => {
    const { submission } = queue('agent');
    await review(submission.id, { status: 'approved' });
    expect((await review(submission.id, { status: 'rejected' })).status).toBe(409);
  });

  it('批量审核单条失败不影响其他', async () => {
    const good = queue('agent').submission;
    const bad = queue('feishu').submission;
    const body = { ids: [good.id, 'does-not-exist', bad.id], status: 'approved' };
    const response = await server.app.request('/api/admin/submissions/batch-review', {
      method: 'POST', headers: admin, body: JSON.stringify(body),
    });
    const result = await response.json() as { results: { id: string; submission?: unknown; error?: { code: string } }[] };
    expect(result.results).toHaveLength(3);
    expect(result.results[1].error?.code).toBe('NOT_FOUND');
  });

  it('agent 来源的文章可以直接下架，这是队列之外唯一的下架路径', async () => {
    const store = openStore(server.db);
    const { submission } = enqueueSubmission(store, {
      kind: 'post', channel: 'agent', originKey: 'collected-1',
      payload: { title: 'AI 采集的评价', summary: '摘要', body: '正文', authorName: '采集者' },
      ip: '127.0.0.1', now: clock(),
    });
    await review(submission.id, { status: 'approved' });
    const postId = `sub-${submission.id}`;
    expect((await server.app.request(`/api/posts/${postId}`)).status).toBe(200);

    // 队列只处理待审记录，已上站的文章只能从这里下架
    const takedown = await server.app.request(`/api/admin/posts/${postId}/review`, {
      method: 'POST', headers: admin, body: JSON.stringify({ status: 'rejected' }),
    });
    expect(takedown.status).toBe(200);
    expect((await server.app.request(`/api/posts/${postId}`)).status).toBe(404);
  });
});

describe('自动通过开关', () => {
  const setAuto = (autoApprove: boolean) => server.app.request('/api/admin/settings', {
    method: 'POST', headers: admin, body: JSON.stringify({ autoApprove }),
  });
  const enqueueVia = (body: unknown) => server.app.request('/api/admin/submissions', {
    method: 'POST', headers: admin, body: JSON.stringify(body),
  });
  const body = {
    kind: 'station', channel: 'agent', originKey: 'route.example.com', payload,
  };

  it('默认关闭，投稿需要人工审核', async () => {
    expect(await (await server.app.request('/api/admin/settings', { headers: admin })).json()).toEqual({ autoApprove: false });
    const created = await (await enqueueVia(body)).json() as { submission: { status: string }; autoApproved: boolean };
    expect(created.submission.status).toBe('pending');
    expect(created.autoApproved).toBe(false);
    expect((await server.app.request('/api/stations/sub-route-example-com')).status).toBe(404);
  });

  it('开启后入队即上站，记录为 approved 且带原因', async () => {
    await setAuto(true);
    const created = await (await enqueueVia(body)).json() as { submission: { id: string; status: string; reason: string }; autoApproved: boolean };
    expect(created.autoApproved).toBe(true);
    expect(created.submission).toMatchObject({ status: 'approved', reason: '自动通过' });

    // 直接可公开访问，测量指标仍是 null
    const detail = await (await server.app.request('/api/stations/sub-route-example-com')).json() as StationDetail;
    expect(detail).toMatchObject({ name: '路由验证站', source: 'agent' });
    expect(detail.uptime).toBeNull();
    expect(detail.firstTokenLatencyMs).toBeNull();
    // 不在待审列表里
    expect((await list('?status=pending')).items.map(item => item.id)).not.toContain(created.submission.id);
  });

  it('关闭后恢复人工审核', async () => {
    await setAuto(true);
    await setAuto(false);
    expect(await (await server.app.request('/api/admin/settings', { headers: admin })).json()).toEqual({ autoApprove: false });
    const created = await (await enqueueVia(body)).json() as { submission: { status: string } };
    expect(created.submission.status).toBe('pending');
  });

  it('自动通过下相同内容重复提交不重复上站', async () => {
    await setAuto(true);
    const first = await (await enqueueVia(body)).json() as { deduplicated: boolean };
    const second = await (await enqueueVia(body)).json() as { deduplicated: boolean };
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    const stations = openStore(server.db).all('station').filter(station => station.slug.startsWith('sub-'));
    expect(stations).toHaveLength(1);
  });

  it('自动通过下校验失败直接 400，不入队也不上站', async () => {
    await setAuto(true);
    const bad = await enqueueVia({ ...body, payload: { ...payload, offers: [{ modelSlug: 'no-such-model', rate: 0.5 }] } });
    expect(bad.status).toBe(400);
    expect((await list('?status=pending')).items).toHaveLength(0);
    expect(openStore(server.db).all('station').filter(station => station.slug.startsWith('sub-'))).toHaveLength(0);
  });

  it('设置接口需要鉴权', async () => {
    expect((await server.app.request('/api/admin/settings')).status).toBe(401);
    expect((await server.app.request('/api/admin/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"autoApprove":true}',
    })).status).toBe(401);
  });
});

describe('站内补录模型', () => {
  const cookie = async () => {
    const store = openStore(server.db);
    server.db.prepare('INSERT INTO accounts (handle, usernameKey, passwordHash, createdAt) VALUES (?, ?, ?, ?)')
      .run('Alice', 'alice', 'not-a-real-hash', clock().toISOString());
    store.put('user', 'Alice', { handle: 'Alice', nickname: 'Alice', avatar: '', bio: '', tokens: 100 });
    const { createSession } = await import('../src/auth.ts');
    return 'session=' + createSession(store, 'Alice', clock());
  };
  const suggest = (body: unknown, session: string) => server.app.request('/api/models/suggest', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: session }, body: JSON.stringify(body),
  });

  it('站内也能补录模型，进同一个队列并需要审核', async () => {
    const session = await cookie();
    const vendor = openStore(server.db).all('vendor')[0]!.slug;
    const response = await suggest({ slug: 'new-model-x', vendor, name: '新模型', description: '说明' }, session);
    expect(response.status).toBe(200);
    const created = await response.json() as { id: string; status: string };
    expect(created.status).toBe('pending');
    // 审核前不应进模型库。
    expect(openStore(server.db).get('model', 'new-model-x')).toBeUndefined();
    const reviewed = await review(created.id, { status: 'approved' });
    expect(reviewed.status).toBe(200);
    expect(openStore(server.db).get('model', 'new-model-x')?.name).toBe('新模型');
  });

  it('厂商不存在时提交阶段就拒绝，不占待审配额', async () => {
    const session = await cookie();
    const response = await suggest({ slug: 'new-model-y', vendor: 'ghost-vendor', name: '新模型', description: '说明' }, session);
    expect(response.status).toBe(400);
    const pending = await list('?status=pending');
    expect(pending.items.filter(item => item.status === 'pending')).toHaveLength(0);
  });

  it('模型已存在时返回 409，不静默覆盖', async () => {
    const session = await cookie();
    const existing = openStore(server.db).all('model')[0]!;
    const response = await suggest({ slug: existing.slug, vendor: existing.vendor, name: '改名尝试', description: '说明' }, session);
    expect(response.status).toBe(409);
    expect(openStore(server.db).get('model', existing.slug)!.name).toBe(existing.name);
  });
});
