import { describe, expect, it } from 'vitest';
import { createApp, openDatabase, openStore } from '../src/node-app.ts';
import { seed } from '../src/seed.ts';

const at = new Date('2026-11-20T00:00:00.000Z');

/** 生产模式：空库只建目录。站点/文章/演示互动数据都不该出现。 */
describe('站点模式：production', () => {
  it('空库只灌厂商与模型目录，不灌虚构站、虚构文章和演示用户', () => {
    const store = openStore(openDatabase(':memory:'));
    seed(store, at, 'production');
    expect(store.all('vendor').length).toBeGreaterThan(0);
    expect(store.all('model').length).toBeGreaterThan(0);
    // 这三类是演示模式专属，生产库里一条都不能凭空出现。
    expect(store.allWithRemoved('station')).toEqual([]);
    expect(store.allWithRemoved('post')).toEqual([]);
    expect(store.all('user')).toEqual([]);
    expect(store.all('banner')).toEqual([]);
  });

  it('目录仍然是可写的分类词典，真实模型可以正常入库', () => {
    const store = openStore(openDatabase(':memory:'));
    seed(store, at, 'production');
    expect(store.get('model', 'deepseek-chat')?.vendor).toBe('deepseek');
    expect(store.get('vendor', 'deepseek')?.name).toBe('DeepSeek');
  });
});

/** demo 模式：保留原有行为，本地开发与展示不受影响。 */
describe('站点模式：demo', () => {
  it('空库灌入虚构站与虚构文章', () => {
    const store = openStore(openDatabase(':memory:'));
    seed(store, at, 'demo');
    expect(store.all('station').length).toBe(12);
    expect(store.all('post').length).toBe(48);
    expect(store.all('user').length).toBeGreaterThan(0);
  });
});

/** 模式是空库时的一次性决定，已有数据不应被二次 seed 改动。 */
describe('站点模式：幂等', () => {
  it('已有数据的库再 seed 不会追加演示站', () => {
    const store = openStore(openDatabase(':memory:'));
    seed(store, at, 'demo');
    const stations = store.all('station').length;
    seed(store, at, 'demo');
    expect(store.all('station').length).toBe(stations);
  });

  it('生产模式下先建一条真实站，再 seed 也不会被目录初始化覆盖', () => {
    const store = openStore(openDatabase(':memory:'));
    seed(store, at, 'production');
    store.put('station', 'real-one', {
      slug: 'real-one', name: '真实站', description: '', url: 'https://real.example.com',
      source: 'submission', rechargeThreshold: null, paymentMethods: [],
      uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null,
    } as never);
    seed(store, at, 'production');
    expect(store.get('station', 'real-one')?.name).toBe('真实站');
    expect(store.all('station').length).toBe(1);
  });
});

/** 非法取值必须启动失败，不能静默退回默认模式。 */
describe('站点模式：配置校验', () => {
  it('拼错的值直接报错，不猜用户想要哪个模式', () => {
    const before = process.env.SITE_MODE;
    process.env.SITE_MODE = 'prod';
    try {
      expect(() => openStore(openDatabase(':memory:')) && createApp({ dbPath: ':memory:' }))
        .toThrow(/SITE_MODE/);
    } finally {
      if (before === undefined) delete process.env.SITE_MODE; else process.env.SITE_MODE = before;
    }
  });
});
