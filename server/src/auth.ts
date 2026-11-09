import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Store } from './database.ts';
import { ApiError } from './errors.ts';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86400000;
const COOKIE = /(?:^|;\s*)session=([A-Za-z0-9_-]{43})(?:;|$)/;

// 账号和种子用户共用 entities 的 user 行。用户名不允许连字符，所以永远撞不上种子的 demo-* 和导入文章的作者。
export const USERNAME = /^[A-Za-z0-9_]{3,20}$/;
export const INITIAL_TOKENS = 120;

const WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '87654321', '11111111', '00000000', '88888888', '66666666',
  'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'qwertyui', 'qwerty123', 'qwertyuiop',
  'abc12345', 'abcd1234', 'abcdefgh', '1q2w3e4r', '1qaz2wsx', 'admin123', 'administrator', 'iloveyou',
  'woaini1314', 'a1234567', 'aa123456', 'letmein1', 'welcome1', 'zhidedeng',
]);
export const isWeakPassword = (password: string) => WEAK_PASSWORDS.has(password.toLowerCase());

/** 限制同时运行的任务数，多余的排队，队列也满时拒绝。 */
export class ConcurrencyGate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly maxRunning: number;
  private readonly maxWaiting: number;

  constructor(maxRunning: number, maxWaiting: number) {
    this.maxRunning = maxRunning;
    this.maxWaiting = maxWaiting;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running < this.maxRunning) {
      this.running++;
    } else {
      if (this.waiting.length >= this.maxWaiting) throw new ApiError(503, 'BUSY', '服务繁忙，请稍后再试');
      // 名额由结束的任务直接转交，running 不变。
      await new Promise<void>(done => this.waiting.push(done));
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

// libuv 线程池默认 4 个线程，静态文件也要用。留出一半，scrypt 再多也拖不垮页面。
const scryptGate = new ConcurrencyGate(2, 16);

function derive(password: string, salt: Buffer) {
  return scryptGate.run(() => new Promise<Buffer>((done, fail) => {
    scrypt(password, salt, KEY_LENGTH, SCRYPT, (error, key) => { if (error) fail(error); else done(key); });
  }));
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${(await derive(password, salt)).toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [, salt, hash] = stored.split('$');
  return timingSafeEqual(await derive(password, Buffer.from(salt, 'base64url')), Buffer.from(hash, 'base64url'));
}

/** 用户名不存在时也算一次哈希，响应时间不暴露用户名是否存在。 */
const placeholderHash = hashPassword(randomBytes(16).toString('hex'));
export async function burnPasswordCheck(password: string) {
  await verifyPassword(password, await placeholderHash);
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export function createSession(store: Store, handle: string, now: Date) {
  const token = randomBytes(32).toString('base64url');
  store.db.prepare('DELETE FROM sessions WHERE expiresAt <= ?').run(now.toISOString());
  store.db.prepare('INSERT INTO sessions (tokenHash, handle, expiresAt) VALUES (?, ?, ?)').run(tokenHash(token), handle, new Date(now.getTime() + SESSION_MS).toISOString());
  return token;
}

export function sessionHandle(store: Store, cookieHeader: string | undefined, now: Date) {
  const token = cookieHeader?.match(COOKIE)?.[1];
  if (!token) return null;
  const row = store.db.prepare('SELECT sessions.handle, sessions.expiresAt FROM sessions JOIN accounts ON accounts.handle = sessions.handle WHERE sessions.tokenHash = ? AND accounts.disabledAt IS NULL').get(tokenHash(token));
  return row && (row.expiresAt as string) > now.toISOString() ? row.handle as string : null;
}

/** 改密码后调用：其他设备上的会话全部失效，当前这个保留。 */
export function deleteOtherSessions(store: Store, handle: string, cookieHeader: string | undefined) {
  const token = cookieHeader?.match(COOKIE)?.[1] ?? '';
  store.db.prepare('DELETE FROM sessions WHERE handle = ? AND tokenHash <> ?').run(handle, tokenHash(token));
}

export function deleteSession(store: Store, cookieHeader: string | undefined) {
  const token = cookieHeader?.match(COOKIE)?.[1];
  if (token) store.db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(tokenHash(token));
}

const cookieFlags = (secure: boolean) => `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
export const sessionCookie = (token: string, secure: boolean) => `session=${token}; Max-Age=${SESSION_DAYS * 86400}; ${cookieFlags(secure)}`;
export const clearedSessionCookie = (secure: boolean) => `session=; Max-Age=0; ${cookieFlags(secure)}`;

/** 进程内滑动窗口计数。服务是单进程，重启清零可以接受。 */
export class AttemptLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  private recent(key: string, now: number) {
    return (this.attempts.get(key) ?? []).filter(time => time > now - this.windowMs);
  }

  /** 还需等待的秒数；0 表示没有被限制。 */
  retryAfter(key: string, now: number) {
    const recent = this.recent(key, now);
    return recent.length < this.max ? 0 : Math.ceil((recent[0] + this.windowMs - now) / 1000);
  }

  /** 当前滑动窗口的剩余次数；查询不预占名额。 */
  remaining(key: string, now: number) {
    return Math.max(0, this.max - this.recent(key, now).length);
  }

  record(key: string, now: number) {
    if (this.attempts.size > 10_000) {
      for (const stale of this.attempts.keys()) if (this.recent(stale, now).length === 0) this.attempts.delete(stale);
    }
    this.attempts.set(key, [...this.recent(key, now), now]);
  }

  /** 撤销最近一次 record：预占的尝试最后没有失败时调用。 */
  release(key: string) {
    this.attempts.get(key)?.pop();
  }

  clear(key: string) {
    this.attempts.delete(key);
  }
}
