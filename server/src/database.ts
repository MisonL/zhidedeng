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
    PRIMARY KEY (kind, id)
  );
  CREATE TABLE IF NOT EXISTS offers (
    stationSlug TEXT NOT NULL, modelSlug TEXT NOT NULL, rate REAL NOT NULL CHECK(rate > 0),
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
  CREATE INDEX IF NOT EXISTS votes_target ON votes(targetType, targetId);
  CREATE INDEX IF NOT EXISTS favorites_target ON favorites(targetType, targetId);
  CREATE INDEX IF NOT EXISTS comments_target ON comments(targetType, targetId, createdAt);
  CREATE INDEX IF NOT EXISTS offers_model ON offers(modelSlug, rate);
  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('station','model','post')),
    channel TEXT NOT NULL CHECK(channel IN ('feishu','agent','web')),
    originKey TEXT NOT NULL,
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

  constructor(db: SqlDatabase, transaction: <T>(action: () => T) => T) {
    this.db = db;
    this.transaction = transaction;
  }

  all<K extends keyof Entities>(kind: K): Entities[K][] {
    return this.db.prepare('SELECT data FROM entities WHERE kind = ? ORDER BY rowid').all(kind)
      .map(row => JSON.parse(row.data as string) as Entities[K]);
  }

  get<K extends keyof Entities>(kind: K, id: string): Entities[K] | undefined {
    const row = this.db.prepare('SELECT data FROM entities WHERE kind = ? AND id = ?').get(kind, id);
    return row ? JSON.parse(row.data as string) as Entities[K] : undefined;
  }

  put<K extends keyof Entities>(kind: K, id: string, value: Entities[K]) {
    this.db.prepare('INSERT INTO entities (kind, id, data) VALUES (?, ?, ?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data')
      .run(kind, id, JSON.stringify(value));
  }
}
