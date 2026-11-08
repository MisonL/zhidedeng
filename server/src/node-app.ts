import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { MIN_SYNC_TOKEN_LENGTH } from './catalog.ts';
import { ensureSubmissionColumns, SCHEMA, Store } from './database.ts';
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

export function createApp(options: { dbPath?: string; now?: () => Date; syncToken?: string; webRoot?: string } = {}) {
  const production = process.env.NODE_ENV === 'production';
  if (production && !options.dbPath && !process.env.DB_PATH) throw new Error('生产环境必须设置 DB_PATH');
  const db = openDatabase(options.dbPath ?? process.env.DB_PATH ?? defaultDbPath);
  const now = options.now ?? (() => new Date());
  const store = openStore(db);
  seed(store, now());
  const configured = options.syncToken ?? process.env.SYNC_TOKEN;
  const usable = configured && configured.length >= MIN_SYNC_TOKEN_LENGTH ? configured : undefined;
  if (configured && !usable) console.warn(`SYNC_TOKEN 不足 ${MIN_SYNC_TOKEN_LENGTH} 位，视为未配置，管理接口已关闭`);
  const app = buildApp(store, now, { secureCookie: production, syncToken: usable });
  if (options.webRoot) mountWeb(app, options.webRoot);
  return { app, db };
}
