import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GetStationsResponse, Post, StationDetail } from '@zhidedeng/shared';
import { createApp } from '../src/node-app.ts';

// 真实提交的站点没有测量数据：可空字段必须如实返回 null，不能当 0 分。
const unmeasured = {
  slug: 'sub-example-com', name: '群友站', description: '群友提交', url: 'https://example.com/', source: 'submission',
  rechargeThreshold: null, paymentMethods: [], uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null,
};

let server: ReturnType<typeof createApp>;
beforeEach(() => {
  server = createApp({ dbPath: ':memory:', now: () => new Date('2026-11-05T01:00:00Z') });
  server.db.prepare('INSERT INTO entities (kind,id,data) VALUES (?,?,?)').run('station', unmeasured.slug, JSON.stringify(unmeasured));
  server.db.prepare('INSERT INTO offers (stationSlug,modelSlug,rate) VALUES (?,?,?)').run(unmeasured.slug, 'gpt-4-1', 0.05);
});
afterEach(() => server.db.close());

const stations = async (sort: string) => (await (await server.app.request(`/api/stations?pageSize=50&sort=${sort}`)).json()) as GetStationsResponse;

describe('没有测量数据的站点', () => {
  it('详情如实返回 null，综合得分也是 null 而不是 0', async () => {
    const detail = await (await server.app.request(`/api/stations/${unmeasured.slug}`)).json() as StationDetail;
    expect(detail).toMatchObject({ uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null, rechargeThreshold: null, score: null, lowestRate: 0.05 });
  });

  it('按综合和可用率排序时排在有数据的站点之后', async () => {
    for (const sort of ['score', 'uptime']) {
      const { items } = await stations(sort);
      expect(items.at(-1)!.slug).toBe(unmeasured.slug);
      const measured = items.slice(0, -1).map(s => sort === 'score' ? s.score! : s.uptime!);
      expect(measured).toEqual([...measured].sort((a, b) => b - a));
    }
  });

  it('按倍率排序仍返回真实报价，但不足三个报价的站点排在最后', async () => {
    const { items } = await stations('rate');
    expect(items.at(-1)).toMatchObject({ slug: unmeasured.slug, lowestRate: 0.05 });
  });

  it('种子站点标明是演示来源，用户投稿标明是本人来源', async () => {
    const { items } = await stations('score');
    expect(items[0].source).toBe('demo');
    const seeded = await (await server.app.request('/api/posts/post-1')).json() as Post;
    expect(seeded.source).toBe('demo');
    const json = { 'content-type': 'application/json' };
    const registered = await server.app.request('/api/auth/register', { method: 'POST', headers: json, body: JSON.stringify({ username: 'metrics_user', password: 'correct-horse-battery' }) });
    const mine = await server.app.request('/api/posts', { method: 'POST', headers: { ...json, cookie: registered.headers.get('set-cookie')!.split(';')[0] }, body: JSON.stringify({ kind: 'guide', title: 't', summary: 's', body: 'b' }) });
    expect((await mine.json() as Post).source).toBe('user');
  });
});
