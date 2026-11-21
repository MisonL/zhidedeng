import { beforeEach, describe, expect, it } from 'vitest';
import { createSession, purgeExpired } from '../src/auth.ts';
import { openDatabase, openStore } from '../src/node-app.ts';

let db: ReturnType<typeof openDatabase>;
let store: ReturnType<typeof openStore>;

beforeEach(() => {
  db = openDatabase(':memory:');
  store = openStore(db);
  // accounts 是独立表且有外键被 sessions 引用，不能走 store.put（那是 entities）。
  db.prepare('INSERT INTO accounts (handle, usernameKey, passwordHash, createdAt) VALUES (?, ?, ?, ?)')
    .run('someone', 'someone', 'x', '2026-01-01T00:00:00.000Z');
});

const count = (table: string) => (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;

describe('过期数据清理', () => {
  it('清掉过期会话，保留未过期的', () => {
    const start = new Date('2026-11-01T00:00:00.000Z');
    createSession(store, 'someone', start);
    // 31 天后：上一会话已过期（有效期 30 天）。
    purgeExpired(store, new Date(start.getTime() + 31 * 86400000));
    expect(count('sessions')).toBe(0);
  });

  it('未过期会话不会被误删', () => {
    const start = new Date('2026-11-01T00:00:00.000Z');
    createSession(store, 'someone', start);
    purgeExpired(store, new Date(start.getTime() + 86400000));
    expect(count('sessions')).toBe(1);
  });

  it('清掉远超窗口的限流记录', () => {
    const now = Date.parse('2026-11-01T00:00:00.000Z');
    db.prepare('INSERT INTO rate_limits (bucket, key, at) VALUES (?, ?, ?)').run('login-ip', 'k', now - 3 * 3600 * 1000);
    purgeExpired(store, new Date(now));
    expect(count('rate_limits')).toBe(0);
  });

  it('仍在窗口内的限流记录保留（最长窗口 1 小时）', () => {
    const now = Date.parse('2026-11-01T00:00:00.000Z');
    db.prepare('INSERT INTO rate_limits (bucket, key, at) VALUES (?, ?, ?)').run('login-ip', 'k', now - 3600 * 1000);
    purgeExpired(store, new Date(now));
    expect(count('rate_limits')).toBe(1);
  });

  it('长时间没人登录也会清（不再只靠 createSession 顺带清）', () => {
    const start = new Date('2026-11-01T00:00:00.000Z');
    createSession(store, 'someone', start);
    // 期间没有任何登录，只有定时任务在跑。
    purgeExpired(store, new Date(start.getTime() + 40 * 86400000));
    expect(count('sessions')).toBe(0);
  });
});
