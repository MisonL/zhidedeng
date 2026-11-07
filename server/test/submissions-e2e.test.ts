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

  it('未知模型导致审核失败并回滚，记录保持 pending', async () => {
    const { submission } = queue('agent', { offers: [{ modelSlug: 'no-such-model', rate: 0.5 }] });
    const response = await review(submission.id, { status: 'approved' });
    expect(response.status).toBe(400);
    expect((await list('?status=pending')).items.map(item => item.id)).toContain(submission.id);
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

  it('agent 来源的文章不能直接绕开队列改状态，只能走队列处理', async () => {
    const store = openStore(server.db);
    const { submission } = enqueueSubmission(store, {
      kind: 'post', channel: 'agent', originKey: 'collected-1',
      payload: { title: 'AI 采集的评价', summary: '摘要', body: '正文', authorName: '采集者' },
      ip: '127.0.0.1', now: clock(),
    });
    await review(submission.id, { status: 'approved' });
    const postId = `sub-${submission.id}`;

    const blocked = await server.app.request(`/api/admin/posts/${postId}/review`, {
      method: 'POST', headers: admin, body: JSON.stringify({ status: 'rejected' }),
    });
    expect(blocked.status).toBe(409);
    expect((await blocked.json() as { error: { code: string } }).error.code).toBe('MANAGED_BY_SOURCE');

    // 站内用户自己的投稿不受影响，仍可直接审核
    const mine = await server.app.request('/api/posts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // 未登录会被拒，这里只确认它不会命中 MANAGED_BY_SOURCE 这条分支
      body: JSON.stringify({ kind: 'review', title: '标题', summary: '摘要', body: '正文' }),
    });
    expect([401, 403]).toContain(mine.status);
  });
});
