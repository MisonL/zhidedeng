import { beforeEach, describe, expect, it } from 'vitest';
import { AttemptLimiter } from '../src/auth.ts';
import { openDatabase, openStore } from '../src/node-app.ts';

let db: ReturnType<typeof openDatabase>;
const now = Date.parse('2026-11-12T00:00:00Z');
const HOUR = 60 * 60 * 1000;

beforeEach(() => { db = openDatabase(':memory:'); });

describe('限流计数跨进程共享', () => {
  it('两个独立实例共用同一个库时共享计数', () => {
    // 模拟两个进程：各自 new 一个限流器，但写的是同一个库。
    const a = new AttemptLimiter(3, HOUR, { db }, 'login-ip');
    const b = new AttemptLimiter(3, HOUR, { db }, 'login-ip');

    a.record('1.2.3.4', now);
    a.record('1.2.3.4', now);
    expect(b.remaining('1.2.3.4', now)).toBe(1);

    b.record('1.2.3.4', now);
    // 内存版在这里会各算各的，配额被放大成两倍。
    expect(a.retryAfter('1.2.3.4', now)).toBeGreaterThan(0);
    expect(b.retryAfter('1.2.3.4', now)).toBeGreaterThan(0);
  });

  it('不同桶互不干扰', () => {
    const ip = new AttemptLimiter(2, HOUR, { db }, 'login-ip');
    const target = new AttemptLimiter(2, HOUR, { db }, 'login-target');
    ip.record('same-key', now);
    ip.record('same-key', now);
    expect(ip.remaining('same-key', now)).toBe(0);
    // 同一个 key 在另一个桶里应该还是满的。
    expect(target.remaining('same-key', now)).toBe(2);
  });

  it('窗口过期后重新计数', () => {
    const limiter = new AttemptLimiter(2, HOUR, { db }, 'login-ip');
    limiter.record('1.2.3.4', now);
    limiter.record('1.2.3.4', now);
    expect(limiter.remaining('1.2.3.4', now)).toBe(0);
    expect(limiter.remaining('1.2.3.4', now + HOUR + 1)).toBe(2);
  });

  it('release 撤销最近一次记录', () => {
    const limiter = new AttemptLimiter(2, HOUR, { db }, 'login-ip');
    limiter.record('1.2.3.4', now);
    limiter.record('1.2.3.4', now + 1000);
    expect(limiter.remaining('1.2.3.4', now)).toBe(0);
    limiter.release('1.2.3.4');
    expect(limiter.remaining('1.2.3.4', now)).toBe(1);
  });

  it('clear 清空某个 key 的全部计数', () => {
    const limiter = new AttemptLimiter(2, HOUR, { db }, 'login-ip');
    limiter.record('1.2.3.4', now);
    limiter.record('1.2.3.4', now);
    limiter.clear('1.2.3.4');
    expect(limiter.remaining('1.2.3.4', now)).toBe(2);
  });

  it('写入时顺带回收过期记录，表不会无限增长', () => {
    const limiter = new AttemptLimiter(100, HOUR, { db }, 'login-ip');
    for (let index = 0; index < 20; index += 1) limiter.record(`old${index}`, now);
    const count = () => (db.prepare('SELECT count(*) AS count FROM rate_limits').get() as { count: number }).count;
    expect(count()).toBe(20);
    // 一个窗口之后再写一条，旧的应当被清掉。
    limiter.record('fresh', now + HOUR + 1);
    expect(count()).toBe(1);
  });
});
