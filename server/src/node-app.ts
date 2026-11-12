import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { MIN_SYNC_TOKEN_LENGTH } from './catalog.ts';
import { ensureAgentTokenColumns, ensureSubmissionColumns, SCHEMA, Store } from './database.ts';
import type { SqlDatabase } from './database.ts';
import { seed } from './seed.ts';
import { mountWeb } from './static.ts';

// 只用于本地开发；生产环境必须显式设置 DB_PATH。
export const defaultDbPath = fileURLToPath(new URL('../data/app.db', import.meta.url));

export function openDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
    `);
    const hasSubmissions = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'submissions'").get() !== undefined;
    if (hasSubmissions) ensureSubmissionColumns(openStore(db));
    db.exec(SCHEMA);
    if (!hasSubmissions) ensureSubmissionColumns(openStore(db));
    // 旧库的 entities 表没有 removedAt，补一列。放在 SCHEMA 之后：
    // 新库走到这里表已经建好，旧库也早就存在。
    const hasRemovedAt = db.prepare('PRAGMA table_info(entities)').all().some(row => row.name === 'removedAt');
    if (!hasRemovedAt) db.exec('ALTER TABLE entities ADD COLUMN removedAt TEXT');
    ensureAgentTokenColumns(openStore(db));
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function openStore(db: DatabaseSync) {
  return new Store(db as unknown as SqlDatabase, action => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

export function createApp(options: { dbPath?: string; now?: () => Date; syncToken?: string; inviteCodes?: readonly string[]; webRoot?: string; trustedProxies?: string; secureCookie?: boolean } = {}) {
  const production = process.env.NODE_ENV === 'production';
  if (production && !options.dbPath && !process.env.DB_PATH) throw new Error('生产环境必须设置 DB_PATH');
  const db = openDatabase(options.dbPath ?? process.env.DB_PATH ?? defaultDbPath);
  const now = options.now ?? (() => new Date());
  const store = openStore(db);
  seed(store, now());
  const configured = options.syncToken ?? process.env.SYNC_TOKEN;
  const usable = configured && configured.length >= MIN_SYNC_TOKEN_LENGTH ? configured : undefined;
  if (configured && !usable) console.warn(`SYNC_TOKEN 不足 ${MIN_SYNC_TOKEN_LENGTH} 位，视为未配置，管理接口已关闭`);
  const inviteCodes = options.inviteCodes ?? (process.env.INVITE_CODES ?? '').split(',').map(code => code.trim()).filter(Boolean);
  // 容器部署时请求从 Docker 网桥进来，不配这个会让所有用户的 IP 限流落进同一个桶。
  const trustedProxies = options.trustedProxies ?? process.env.TRUSTED_PROXIES ?? '';
    // 只在生产且显式开启 TLS 时要求 Secure；本机 http 试用不该被静默登不上。
  // 显式传入的选项优先（测试用），否则按生产 + TLS_ENABLED 决定。
  const cookieSecure = options.secureCookie ?? (production && process.env.TLS_ENABLED === '1');
  const app = buildApp(store, now, { secureCookie: cookieSecure, syncToken: usable, inviteCodes, trustedProxies });
  if (options.webRoot) mountWeb(app, options.webRoot);
  return { app, db, store };
}
