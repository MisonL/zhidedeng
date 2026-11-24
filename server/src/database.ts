import type { Banner, ContentSource, Model, Post, Station, User, Vendor } from '@zhidedeng/shared';

export type StationRecord = Omit<Station, 'votes' | 'currentUserVote' | 'favorited' | 'favoriteCount' | 'commentCount' | 'lowestRate' | 'score'>;
// 用户投稿不写 source，读取时即 'user'。
// 群友提交的作者只是一个展示昵称，存在 authorNickname 里，不是 users 里的账号，也不进达人榜。
export type PostRecord = Omit<Post, 'votes' | 'currentUserVote' | 'favorited' | 'favoriteCount' | 'commentCount' | 'author' | 'source'> & {
  authorHandle: string;
  authorNickname?: string;
  source?: ContentSource | 'user';
};
export interface Entities {
  vendor: Vendor;
  model: Model;
  station: StationRecord;
  user: User;
  post: PostRecord;
  banner: Banner;
}

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS entities (
    kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
    -- 软删除标记。下架不真删，恢复只需把这一列清空：
    -- 站点以自动运行为主，一次误读不该让整批数据消失。
    removedAt TEXT,
    PRIMARY KEY (kind, id)
  );
  CREATE TABLE IF NOT EXISTS offers (
    stationSlug TEXT NOT NULL, modelSlug TEXT NOT NULL, rate REAL NOT NULL CHECK(rate > 0),
    -- 计价口径：同一个 rate 在不同口径下不可比。默认 blended 让老数据与
    -- 老写入方（没这个字段的）继续按原语义读，不需要一次性回填。
    basis TEXT NOT NULL DEFAULT 'blended' CHECK(basis IN ('blended','input','output','package')),
    -- 报价来源时间。NULL 表示来源没说，**不等于「刚刚」**——列表按它排序时要
    -- 把未知排在已知的后面，而不是当成最新。
    quotedAt TEXT,
    PRIMARY KEY (stationSlug, modelSlug)
  );
  CREATE TABLE IF NOT EXISTS votes (
    userHandle TEXT NOT NULL, targetType TEXT NOT NULL CHECK(targetType IN ('post','station')),
    targetId TEXT NOT NULL, value TEXT NOT NULL CHECK(value IN ('up','down')),
    PRIMARY KEY (userHandle, targetType, targetId)
  );
  CREATE TABLE IF NOT EXISTS favorites (
    userHandle TEXT NOT NULL, targetType TEXT NOT NULL CHECK(targetType IN ('post','station')),
    targetId TEXT NOT NULL, createdAt TEXT NOT NULL,
    PRIMARY KEY (userHandle, targetType, targetId)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY, userHandle TEXT NOT NULL, targetType TEXT NOT NULL CHECK(targetType IN ('post','station')),
    targetId TEXT NOT NULL, content TEXT NOT NULL, parentId TEXT REFERENCES comments(id), createdAt TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS checkins (
    userHandle TEXT NOT NULL, date TEXT NOT NULL, tokensAwarded INTEGER NOT NULL, streak INTEGER NOT NULL,
    PRIMARY KEY (userHandle, date)
  );
  CREATE TABLE IF NOT EXISTS accounts (
    handle TEXT PRIMARY KEY, usernameKey TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL, createdAt TEXT NOT NULL,
    disabledAt TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    tokenHash TEXT PRIMARY KEY, handle TEXT NOT NULL REFERENCES accounts(handle), expiresAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_tokens (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    tokenHash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    tokenPrefix TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    lastUsedAt TEXT,
    revokedAt TEXT,
    useCount INTEGER NOT NULL DEFAULT 0
  );
  -- entities 的读取几乎都是「按 kind 取在线条目再按 rowid 排序」，
  -- 而主键是 (kind, id)，排 rowid 会让 SQLite 建临时 B 树排序。
  -- 2 万篇文章实测这一层占 55% 的读取耗时，加这个索引后计划里不再出现 TEMP B-TREE。
  CREATE INDEX IF NOT EXISTS entities_kind_removed ON entities(kind, removedAt);
  -- 按作者统计/筛选文章用。没有它，countOwnPosts（/api/me 每次页面加载都调）
  -- 要扫全部 post 并把每一行 JSON.parse 一遍：1000 篇时 278ms。
  -- 表达式索引让这个计数变成一次索引查找，且不需要改表结构（老库自动补建）。
  CREATE INDEX IF NOT EXISTS entities_post_author ON entities(json_extract(data,'$.authorHandle')) WHERE kind = 'post';
  -- 只看已上线的文章：列表、榜单、搜索都以它为起点。把过滤下推给 SQLite，
  -- 避免为每篇待审/被拒的文章也付一次 JSON.parse。
  CREATE INDEX IF NOT EXISTS entities_post_approved ON entities(json_extract(data,'$.status')) WHERE kind = 'post' AND removedAt IS NULL;
  CREATE INDEX IF NOT EXISTS agent_tokens_handle ON agent_tokens(handle);
  -- 限流计数。放库里而不是进程内存里，是为了让同一个库上的多个进程共享同一份计数：
  -- 内存版在多进程下每个进程各算各的，配额实际被放大成 N 倍。
  -- 注意这只覆盖「共享同一个库文件」的进程；跨主机部署仍需换共享存储。
  -- 邀请码。原先只是环境变量里的静态白名单：发一个码等于发无限个码。
  -- 这里落到表上，带次数、有效期、核销记录与吊销。
  -- 只存哈希与前缀，明文仅在签发那一刻返回一次，库被读走也拿不到可用码。
  CREATE TABLE IF NOT EXISTS invite_codes (
    id         TEXT PRIMARY KEY,
    codeHash   TEXT NOT NULL UNIQUE,
    codePrefix TEXT NOT NULL,
    note       TEXT,
    maxUses    INTEGER,
    usedCount  INTEGER NOT NULL DEFAULT 0,
    createdAt  TEXT NOT NULL,
    expiresAt  TEXT,
    revokedAt  TEXT
  );
  CREATE TABLE IF NOT EXISTS invite_code_uses (
    codeId TEXT NOT NULL REFERENCES invite_codes(id),
    handle TEXT NOT NULL,
    usedAt TEXT NOT NULL,
    PRIMARY KEY (codeId, handle)
  );
  CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT NOT NULL,
    key    TEXT NOT NULL,
    at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rate_limits_lookup ON rate_limits(bucket, key, at);
  -- 过期清理是按 (bucket, at) 删的，没有 key 前缀就用不上 rate_limits_lookup。
  CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(bucket, at);
  -- 会话清理（登出/改密/禁用/过期回收）都是按 handle 或 expiresAt 扫，
  -- 没有索引时每次都要全表读一遍 sessions。表小的时候看不出来，登录态一多就是线性成本。
  CREATE INDEX IF NOT EXISTS sessions_handle ON sessions(handle);
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expiresAt);
  -- 「我的收藏」按人取再按时间排，原来只有 (targetType,targetId) 用不上。
  CREATE INDEX IF NOT EXISTS favorites_user ON favorites(userHandle, createdAt);
  CREATE INDEX IF NOT EXISTS votes_target ON votes(targetType, targetId);
  CREATE INDEX IF NOT EXISTS favorites_target ON favorites(targetType, targetId);
  CREATE INDEX IF NOT EXISTS comments_target ON comments(targetType, targetId, createdAt);
  -- 发评论前的频率限制按 (userHandle, createdAt) 查，comments_target 那条用不上，
  -- 之前是每次评论都全表扫一遍。
  CREATE INDEX IF NOT EXISTS comments_author ON comments(userHandle, createdAt);
  CREATE INDEX IF NOT EXISTS offers_model ON offers(modelSlug, rate);
  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('station','model','post')),
    channel TEXT NOT NULL CHECK(channel IN ('feishu','agent','web')),
    originKey TEXT NOT NULL,
    batchId TEXT,
    action TEXT NOT NULL DEFAULT 'upsert' CHECK(action IN ('upsert','remove')),
    autoApproved INTEGER NOT NULL DEFAULT 0 CHECK(autoApproved IN (0,1)),
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    payloadHash TEXT NOT NULL,
    actorHandle TEXT,
    ip TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','superseded')),
    reason TEXT,
    reviewedAt TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS submissions_status ON submissions(status, kind, createdAt);
  CREATE INDEX IF NOT EXISTS submissions_origin ON submissions(kind, originKey, status);
  CREATE INDEX IF NOT EXISTS submissions_actor ON submissions(actorHandle, createdAt);
  CREATE INDEX IF NOT EXISTS submissions_dedupe ON submissions(kind, originKey, action, batchId, payloadHash, status, createdAt);
  -- 管理端的运行时开关，管理员随时改，所以存库不存启动配置。
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
`;

/** 存储层用到的 node:sqlite 最小接口。 */
export interface SqlDatabase {
  prepare(sql: string): {
    run(...params: SqlValue[]): unknown;
    get(...params: SqlValue[]): SqlRow | undefined;
    all(...params: SqlValue[]): SqlRow[];
  };
}
export type SqlValue = string | number | null;
export type SqlRow = Record<string, unknown>;

export class Store {
  readonly db: SqlDatabase;
  readonly transaction: <T>(action: () => T) => T;
  /** 当前是否已在事务里。只读函数据此决定要不要自己开读事务，避免嵌套。 */
  readonly inTransaction: () => boolean;

  constructor(db: SqlDatabase, transaction: <T>(action: () => T) => T, inTransaction: () => boolean = () => false) {
    this.inTransaction = inTransaction;
    this.db = db;
    this.transaction = transaction;
  }

  /** 在线条目。已下架的不出现，所有对外读取路径都走这里。 */
  all<K extends keyof Entities>(kind: K): Entities[K][] {
    return this.db.prepare('SELECT data FROM entities WHERE kind = ? AND removedAt IS NULL ORDER BY rowid').all(kind)
      .map(row => JSON.parse(row.data as string) as Entities[K]);
  }

  /** 按 id 取在线条目；已下架的视为不存在。 */
  get<K extends keyof Entities>(kind: K, id: string): Entities[K] | undefined {
    const row = this.db.prepare('SELECT data FROM entities WHERE kind = ? AND id = ? AND removedAt IS NULL').get(kind, id);
    return row ? JSON.parse(row.data as string) as Entities[K] : undefined;
  }

  /** 含已下架的全部条目，只给需要判重和恢复的内部逻辑用。 */
  getWithRemoved<K extends keyof Entities>(kind: K, id: string): Entities[K] | undefined {
    const row = this.db.prepare('SELECT data FROM entities WHERE kind = ? AND id = ?').get(kind, id);
    return row ? JSON.parse(row.data as string) as Entities[K] : undefined;
  }

  /** 该条目是否已被软删除（下架）。比 allWithRemoved 便宜，只查一列。 */
  removedAt<K extends keyof Entities>(kind: K, id: string): string | null {
    const row = this.db.prepare('SELECT removedAt FROM entities WHERE kind = ? AND id = ?').get(kind, id);
    return (row?.removedAt as string | null | undefined) ?? null;
  }

  /** 含已下架的全部条目，只给需要认领 slug、判重和恢复的内部逻辑用。 */
  allWithRemoved<K extends keyof Entities>(kind: K): Entities[K][] {
    return this.db.prepare('SELECT data FROM entities WHERE kind = ? ORDER BY rowid').all(kind)
      .map(row => JSON.parse(row.data as string) as Entities[K]);
  }

  /** 恢复：把 removedAt 清空。返回是否真的恢复了一个已下架条目。 */
  restore(kind: keyof Entities, id: string): boolean {
    const result = this.db.prepare('UPDATE entities SET removedAt = NULL WHERE kind = ? AND id = ? AND removedAt IS NOT NULL').run(kind, id) as { changes?: number };
    const changed = Number(result?.changes ?? 0) > 0;
    // 恢复会改变「哪些条目在线」，缓存必须作废，否则下架的站点会一直被当成不在线。
    if (changed) this.entityVersion += 1;
    return changed;
  }

  /** 软删除：标记下架时间，数据保留。 */
  markRemoved(kind: keyof Entities, id: string, at: string): boolean {
    const result = this.db.prepare('UPDATE entities SET removedAt = ? WHERE kind = ? AND id = ? AND removedAt IS NULL').run(at, kind, id) as { changes?: number };
    const changed = Number(result?.changes ?? 0) > 0;
    if (changed) this.entityVersion += 1;
    return changed;
  }

  /**
   * 文章是否已被下架（软删除）。
   *
   * `put` 的 SQL 带 `removedAt = NULL`——对站点这是「重新上架就是清标记」，
   * 对文章却是有毒的：任何一条「把内容写一遍」的路径都会顺带撤销下架，
   * 管理员的下架等于白做。所以凡是写文章之前都要先问这一句。
   *
   * 已有两处各自手写过同样的查询（飞书同步、运维导入），而作者自删、
   * 注销清理、编辑过审都会再引入新的写入点。散着写必然会漏一处，
   * 所以收敛到这里，让「忘记检查」变成一件要显式绕开的事。
   */
  postRemovedAt(id: string): string | null {
    const row = this.db.prepare("SELECT removedAt FROM entities WHERE kind = 'post' AND id = ?").get(id) as
      { removedAt: string | null } | undefined;
    return row?.removedAt ?? null;
  }

  put<K extends keyof Entities>(kind: K, id: string, value: Entities[K]) {
    // 重新写入等于恢复：同一个 slug 再次上架时，软删除标记要一并清掉。
    this.db.prepare('INSERT INTO entities (kind, id, data, removedAt) VALUES (?, ?, ?, NULL) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, removedAt=NULL')
      .run(kind, id, JSON.stringify(value));
    // 写进去的东西可能正在被某次批量审核当作查找依据，让缓存作废。
    this.entityVersion += 1;
  }

  /**
   * 让缓存作废。任何直接写 entities 的地方（不只是 put/markRemoved/restore）
   * 都要在写后调用一次——比如导入流程的 `DELETE FROM entities`。
   * 忘记调用的后果不是崩溃，而是读到写之前的快照，那更难查。
   */
  invalidate(): void {
    this.entityVersion += 1;
  }

  /**
   * 版本号：任何 put 都会 +1，供调用方判断自己那份派生索引是否过期。
   *
   * 用来消掉「批量审核时每条都全表扫描 JSON 找站点」的 O(n·m)：调用方发现
   * 版本没变就复用自己上次建好的 Map。这里不放缓存本体，是因为派生结果的
   * 形状（按 hostname？按 slug？）属于调用方的知识，塞进 Store 会越界。
   */
  entityVersion = 0;
}

// 表名只来自本文件内的常量，不接受外部输入，拼进 SQL 是安全的。
function ensureColumn(db: SqlDatabase, column: string, definition: string, table = 'submissions') {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
  if (!exists) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

/** 建表不会补旧表的列。先幂等补列，再建依赖新列的索引，保留全部旧投稿。 */
/** 补齐 agent_tokens 后加的列。老库或不完整的库都可能缺。 */
export function ensureAgentTokenColumns(store: Store) {
  const table = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_tokens'").get();
  if (!table) return; // 表不存在时由 SCHEMA 的 CREATE TABLE 建全，不需要补列。
  store.transaction(() => {
    ensureColumn(store.db, 'tokenPrefix', "TEXT NOT NULL DEFAULT ''", 'agent_tokens');
  });
}

/**
 * 旧库的 offers 表补两列。
 *
 * 建表用的是 `CREATE TABLE IF NOT EXISTS`，对已存在的库不生效——所以新字段
 * 必须走 ALTER。CHECK 约束在这里补不上（SQLite 不能给已有列加约束），
 * 口径合法性由应用层 `rateBasis` 校验保证。
 */
export function ensureOfferColumns(store: Store) {
  store.transaction(() => {
    ensureColumn(store.db, 'basis', "TEXT NOT NULL DEFAULT 'blended'", 'offers');
    ensureColumn(store.db, 'quotedAt', 'TEXT', 'offers');
  });
}

export function ensureSubmissionColumns(store: Store) {
  store.transaction(() => {
    ensureColumn(store.db, 'batchId', 'TEXT');
    ensureColumn(store.db, 'action', "TEXT NOT NULL DEFAULT 'upsert' CHECK(action IN ('upsert','remove'))");
    ensureColumn(store.db, 'autoApproved', 'INTEGER NOT NULL DEFAULT 0 CHECK(autoApproved IN (0,1))');
    store.db.prepare('CREATE INDEX IF NOT EXISTS submissions_batch ON submissions(batchId, status)').run();
    store.db.prepare('CREATE INDEX IF NOT EXISTS submissions_dedupe ON submissions(kind, originKey, action, batchId, payloadHash, status, createdAt)').run();
  });
}
