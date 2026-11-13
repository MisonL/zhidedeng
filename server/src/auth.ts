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
/**
 * 口令强度检查。
 *
 * 早先只是一张 30 词的精确匹配表，`admin1234`、`qwerty1234`、`aaaaaaaa` 全部放行——
 * 撞库和口令喷洒（用几个常见口令打大量账号）几乎不受阻。
 *
 * 拆成两个层次，避免用一条粗暴规则同时误伤和漏判：
 * - **必须**满足的最低门槛：长度与种类，不满足直接拒。
 * - 在此基础上再判「明显有规律」，这类才是真正常见的口令。
 *   判据要覆盖整段而不是「包含某个 4 连」——后者放过 welcome123、P@ssw0rd!x，
 *   也放过 Hunter2hunter2，因为它们只是「某一部分有规律」。
 */
const MIN_LENGTH = 10;

/** 键盘行与相邻键位。斜着按（qaz、wsx）也是常见的手指路径。 */
const KEYBOARD_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const KEYBOARD_DIAGONALS = ['1qaz', '2wsx', '3edc', '4rfv', '5tgb', '6yhn', '7ujm', '8ik,', '9ol.', '0p;/'];

/** 口令里最常见的英文词根。只用来判断「去掉数字后剩下的主体是不是个常见词」。 */
const COMMON_WORDS = ['password', 'passwd', 'welcome', 'admin', 'qwerty', 'abc', 'iloveyou', 'letmein',
  'monkey', 'dragon', 'master', 'sunshine', 'princess', 'football', 'baseball', 'zhidedeng', 'woaini'];

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

/** 该子串是否是某条序列（含反向）的连续片段。 */
function isRunOf(value: string, sequence: string): boolean {
  const reversed = [...sequence].reverse().join('');
  return sequence.includes(value) || reversed.includes(value);
}

/** 找出字符串里最长的「连续序列」片段长度，键盘行与相邻键位都算。 */
function longestRun(lowered: string): number {
  let longest = 0;
  for (const row of [...KEYBOARD_ROWS, ...KEYBOARD_DIAGONALS]) {
    for (let start = 0; start < lowered.length; start++) {
      for (let length = 2; start + length <= lowered.length; length++) {
        if (!isRunOf(lowered.slice(start, start + length), row)) break;
        longest = Math.max(longest, length);
      }
    }
  }
  // 字母与数字各自的正反向序列单独算：9876543210 是 0123456789 的反向。
  for (const sequence of [ALPHABET, DIGITS]) {
    for (let start = 0; start < lowered.length; start++) {
      for (let length = 2; start + length <= lowered.length; length++) {
        if (!isRunOf(lowered.slice(start, start + length), sequence)) break;
        longest = Math.max(longest, length);
      }
    }
  }
  return longest;
}

/** 连续重复字符（aaa、1111）的最长长度。 */
function longestRepeat(lowered: string): number {
  let longest = 1;
  let current = 1;
  for (let index = 1; index < lowered.length; index++) {
    current = lowered[index] === lowered[index - 1] ? current + 1 : 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

/** 「同一段重复两次以上」，例如 abcabc、Hunter2hunter2、passwordpassword。 */
function isRepeatedBlock(lowered: string): boolean {
  for (let size = 1; size <= Math.floor(lowered.length / 2); size++) {
    if (lowered.length % size !== 0) continue;
    const block = lowered.slice(0, size);
    if (block.repeat(lowered.length / size) === lowered) return true;
  }
  return false;
}

/**
 * @param password 待检查的口令
 * @param username 可选：口令里包含用户名（或反之）时视为弱口令
 */
export function isWeakPassword(password: string, username?: string): boolean {
  const lowered = password.toLowerCase();
  if (WEAK_PASSWORDS.has(lowered)) return true;
  // 最低门槛：长度与字符种类。纯中文口令种类天然很少，但长度足够就放行。
  if ([...password].length < MIN_LENGTH) return true;
  if (new Set(password).size < 4 && !/[\u4e00-\u9fa5]/.test(password)) return true;
  if (isRepeatedBlock(lowered)) return true;
  if (longestRepeat(lowered) >= 4) return true;
  if (longestRun(lowered) >= 4) return true;
  // 「常见词 + 纯数字尾巴」是最典型的弱口令形态：welcome123、P@ssw0rd!x、
  // 2026zhidedeng 都属于这一类，单看序列片段看不出来，必须单独判。
  // 去掉首尾的纯数字段后，剩下的主体是否太短、或是否命中常见词。
  // 先做 leet 归一：P@ssw0rd 与 password 是同一个词，只换写法不换熵。
  // 数字替换要在「去掉首尾数字」之前做，否则 P@ssw0rd 的 0 会被当成尾巴剥掉。
  const leet = lowered.replace(/[4@]/g, 'a').replace(/[3]/g, 'e').replace(/[1!|]/g, 'l')
    .replace(/[0]/g, 'o').replace(/[5$]/g, 's').replace(/[7]/g, 't');
  const core = leet.replace(/^[0-9]+/, '').replace(/[0-9]+$/, '').replace(/[^a-z\u4e00-\u9fa5]/g, '');
  if (core.length < 6 && /[0-9]/.test(lowered)) return true;
  if (COMMON_WORDS.some(word => core.includes(word))) return true;
  if (username && username.length >= 3) {
    const name = username.toLowerCase();
    if (lowered.includes(name) || name.includes(lowered)) return true;
  }
  return false;
}

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

/**
 * 清理过期数据。原先只在 createSession 里顺手清一次 sessions——
 * 长期没人登录就一份也不清；rate_limits 也只清自己那个桶，
 * 某个桶从此不再写入时旧行会一直留着。
 *
 * 两张表的窗口都以小时计，每天清一次足够，开销可忽略。
 */
export function purgeExpired(store: Store, now: Date): void {
  store.db.prepare('DELETE FROM sessions WHERE expiresAt <= ?').run(now.toISOString());
  store.db.prepare('DELETE FROM rate_limits WHERE at <= ?').run(now.getTime() - PURGE_RATE_LIMIT_MS);
}

/** 限流记录的保留期。取最长窗口（1 小时）的两倍，任何仍在生效的计数都不会被误删。 */
const PURGE_RATE_LIMIT_MS = 2 * 60 * 60 * 1000;

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

/** 计数落库所需的最小接口，只依赖这两条语句，避免把整个 Store 拖进来。 */
export interface RateLimitStore {
  db: {
    prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  };
}

/**
 * 滑动窗口计数。
 *
 * 传了 store 就写库：多个进程共用同一个库文件时配额才是真正的全局限额。
 * 不传就用进程内 Map —— 单元测试和单进程部署是这个路径。
 *
 * 库版本只覆盖「共享同一个库文件」的多进程；跨主机部署要另换共享存储。
 * 窗口内的旧记录由 record() 顺便清掉，不需要单独的清理任务。
 */
export class AttemptLimiter {
  private readonly attempts = new Map<string, number[]>();
  /** 内存版：每个 key 已记录的自增序号，与 attempts 里的顺序一一对应。 */
  private readonly ids = new Map<string, number[]>();
  private nextId = 1;
  private readonly max: number;
  private readonly windowMs: number;
  private readonly store?: RateLimitStore;
  private readonly bucket: string;

  constructor(max: number, windowMs: number, store?: RateLimitStore, bucket = 'default') {
    this.max = max;
    this.windowMs = windowMs;
    this.store = store;
    this.bucket = bucket;
  }

  private recent(key: string, now: number): number[] {
    if (this.store) {
      const rows = this.store.db
        .prepare('SELECT at FROM rate_limits WHERE bucket = ? AND key = ? AND at > ? ORDER BY at')
        .all(this.bucket, key, now - this.windowMs) as { at: number }[];
      return rows.map(row => row.at);
    }
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

  /**
   * 记一次尝试，返回可用来精确撤销它的句柄。
   *
   * 句柄是必须的：早先 release() 删的是「该 key 最新一条」，而调用方通常在
   * 一个事务回滚之后才撤销——那时本次预占已经随回滚消失，删掉的就是上一次
   * 成功的记录，配额被无限释放。
   */
  record(key: string, now: number): number {
    if (this.store) {
      // 顺手清掉本桶过期的记录：没有单独清理任务，靠写入顺带回收。
      this.store.db.prepare('DELETE FROM rate_limits WHERE bucket = ? AND at <= ?').run(this.bucket, now - this.windowMs);
      const result = this.store.db.prepare('INSERT INTO rate_limits (bucket, key, at) VALUES (?, ?, ?)').run(this.bucket, key, now) as { lastInsertRowid: number | bigint };
      return Number(result.lastInsertRowid);
    }
    if (this.attempts.size > 10_000) {
      for (const stale of this.attempts.keys()) if (this.recent(stale, now).length === 0) this.attempts.delete(stale);
    }
    const entry = { id: this.nextId++, at: now };
    // 这里存的是**未过滤**的完整列表：ids 里的序号与 attempts 的下标必须一一对应，
    // 否则随着旧记录过期，「第几条」的映射会整体错位，撤销就删到别的条上。
    // 过期条目的过滤放在 recent() 读取时做。
    const times = this.attempts.get(key);
    if (times) times.push(now); else this.attempts.set(key, [now]);
    const sequence = this.ids.get(key);
    if (sequence) sequence.push(entry.id); else this.ids.set(key, [entry.id]);
    return entry.id;
  }

  /**
   * 撤销**这一次**预占。id 来自 record() 的返回值。
   * 不带 id 时退回「删最新一条」，仅供确实没有句柄的历史调用点使用。
   */
  release(key: string, id?: number) {
    if (this.store) {
      if (id === undefined) {
        this.store.db.prepare('DELETE FROM rate_limits WHERE rowid = (SELECT rowid FROM rate_limits WHERE bucket = ? AND key = ? ORDER BY at DESC, rowid DESC LIMIT 1)')
          .run(this.bucket, key);
        return;
      }
      // 按 rowid 精确删。事务回滚后这条已不存在，删除自然成为空操作——
      // 这正是想要的：不能因为撤销而抹掉别人的计数。
      this.store.db.prepare('DELETE FROM rate_limits WHERE rowid = ? AND bucket = ? AND key = ?').run(id, this.bucket, key);
      return;
    }
    const times = this.attempts.get(key);
    if (!times) return;
    if (id === undefined) { times.pop(); return; }
    // 按插入序号找到它是这个 key 的第几条记录，删那一条。
    // 只用时间戳定位会在「同一毫秒多条」时删错——撤销一次却抹掉了另一次的计数。
    const sequence = this.ids.get(key);
    if (!sequence) return;
    const position = sequence.indexOf(id);
    if (position < 0) return;
    if (position < times.length) times.splice(position, 1);
    sequence.splice(position, 1);
    if (sequence.length === 0) this.ids.delete(key);
  }

  clear(key: string) {
    if (this.store) {
      this.store.db.prepare('DELETE FROM rate_limits WHERE bucket = ? AND key = ?').run(this.bucket, key);
      return;
    }
    this.attempts.delete(key);
  }
}
