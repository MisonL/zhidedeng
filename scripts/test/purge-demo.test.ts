import { describe, expect, it } from 'vitest';
import { openDatabase, openStore } from '../../server/src/node-app.ts';
import { seed } from '../../server/src/seed.ts';
import { applyPurge, planPurge } from '../purge-demo.ts';

const at = new Date('2026-11-20T00:00:00.000Z');
const demoStore = () => {
  const store = openStore(openDatabase(':memory:'));
  seed(store, at, 'demo');
  return store;
};

describe('清除演示数据', () => {
  it('默认能找到全部演示内容与它们的关联数据', () => {
    const plan = planPurge(demoStore());
    expect(plan.stations.length).toBe(12);
    expect(plan.posts.length).toBe(48);
    expect(plan.users.length).toBeGreaterThan(0);
    expect(plan.banners.length).toBe(3);
    // 演示站 12 个，每个 6~15 条报价，不能是 0。
    expect(plan.offers).toBeGreaterThan(0);
    expect(plan.votes).toBeGreaterThan(0);
    expect(plan.comments).toBeGreaterThan(0);
  });

  it('只删演示数据，真实投稿与真实账号一条不动', () => {
    const store = demoStore();
    // 造一条真实站、一篇真实文章、一个真实用户，模拟生产库里混着两种情况。
    store.put('station', 'real-example-com', {
      slug: 'real-example-com', name: '真实站', description: '', url: 'https://real.example.com',
      source: 'submission', rechargeThreshold: null, paymentMethods: [],
      uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null,
    } as never);
    store.put('post', 'real-post', {
      id: 'real-post', kind: 'review', title: '真实文章', summary: '', body: '', authorHandle: 'realuser',
      stationSlug: null, modelSlug: null, cover: null, publishedAt: at.toISOString(), source: 'user', status: 'approved',
    } as never);
    store.put('user', 'realuser', { handle: 'realuser', nickname: '真人', avatar: '', bio: '', tokens: 120 } as never);
    store.db.prepare("INSERT INTO offers (stationSlug, modelSlug, rate, basis, quotedAt) VALUES ('real-example-com','deepseek-chat',0.5,'blended',NULL)").run();

    const plan = planPurge(store);
    applyPurge(store, plan);

    expect(store.get('station', 'real-example-com')?.name).toBe('真实站');
    expect(store.get('post', 'real-post')?.title).toBe('真实文章');
    expect(store.get('user', 'realuser')?.nickname).toBe('真人');
    const offers = store.db.prepare("SELECT COUNT(*) c FROM offers WHERE stationSlug = 'real-example-com'").get() as { c: number };
    expect(Number(offers.c)).toBe(1);
    // 演示数据全没了。
    expect(store.allWithRemoved('station').some(s => s.source === 'demo')).toBe(false);
    expect(store.allWithRemoved('post').some(p => p.source === 'demo')).toBe(false);
    expect(store.all('user').some(u => u.handle.startsWith('demo-'))).toBe(false);
    expect(store.all('banner')).toEqual([]);
  });

  it('清完不留孤儿行：指向已删内容的投票/收藏/评论一并消失', () => {
    const store = demoStore();
    const before = store.db.prepare('SELECT COUNT(*) c FROM votes').get() as { c: number };
    expect(Number(before.c)).toBeGreaterThan(0);
    applyPurge(store, planPurge(store));
    for (const table of ['votes', 'favorites', 'comments']) {
      const row = store.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number };
      expect(Number(row.c)).toBe(0);
    }
    const offers = store.db.prepare('SELECT COUNT(*) c FROM offers').get() as { c: number };
    expect(Number(offers.c)).toBe(0);
  });

  it('生产模式的空库没什么可清，重跑也是幂等的', () => {
    const store = openStore(openDatabase(':memory:'));
    seed(store, at, 'production');
    const plan = planPurge(store);
    expect(plan.stations).toEqual([]);
    expect(plan.posts).toEqual([]);
    expect(plan.users).toEqual([]);
    applyPurge(store, plan);
    applyPurge(store, planPurge(store));
    // 目录不该被清理波及。
    expect(store.all('vendor').length).toBeGreaterThan(0);
    expect(store.all('model').length).toBeGreaterThan(0);
  });
});
