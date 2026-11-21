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

describe('撤销必须精确到条', () => {
  it('事务回滚后撤销不会删掉上一次成功的记录', () => {
    const limiter = new AttemptLimiter(2, HOUR, { db }, 'agent-token');
    // 第一次成功：预占并保留。
    limiter.record('t', now);
    // 第二次预占，随后事务回滚（那一行已经不存在），再执行撤销。
    const second = limiter.record('t', now + 1000);
    db.prepare('DELETE FROM rate_limits WHERE rowid = ?').run(second);
    limiter.release('t', second);
    // 第一次的记录必须还在，否则配额被无限释放。
    expect(limiter.remaining('t', now)).toBe(1);
  });

  it('不带句柄的撤销仍退回最新一条', () => {
    const limiter = new AttemptLimiter(2, HOUR, { db }, 'agent-token');
    limiter.record('t', now);
    limiter.record('t', now + 1000);
    expect(limiter.remaining('t', now)).toBe(0);
    limiter.release('t');
    expect(limiter.remaining('t', now)).toBe(1);
  });
});

describe('内存版限流的精确撤销', () => {
  it('同一毫秒多条记录时撤销的是本次那条，不会删错', () => {
    // 内存版没有 rowid。早先按时间戳 lastIndexOf 定位，同一毫秒里
    // 记录 3 次再撤销第 1 次，删掉的是第 3 次——撤销一次却抹掉别人的计数。
    const limiter = new AttemptLimiter(5, 60_000);
    const first = limiter.record('k', 1000);
    limiter.record('k', 1000);
    limiter.record('k', 1000);
    expect(limiter.remaining('k', 1000)).toBe(2);
    limiter.release('k', first);
    expect(limiter.remaining('k', 1000)).toBe(3);
  });

  it('过期清理不会让后续撤销删错条目', () => {
    const limiter = new AttemptLimiter(5, 1_000);
    const stale = limiter.record('k', 1000);
    limiter.record('k', 1500);
    limiter.record('k', 5000);
    // 前两条已过期（窗口 1 秒 @ 5000），只剩最后一条。
    expect(limiter.remaining('k', 5000)).toBe(4);
    // 撤销一条已过期的记录：序号对得上，但已不在窗口里，不该影响当前剩余。
    limiter.release('k', stale);
    expect(limiter.remaining('k', 5000)).toBe(4);
  });
});
