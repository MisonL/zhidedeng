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

/** 只读打开时跳过建目录与迁移：dry-run 之类的操作不该产生任何写入。 */
export function openDatabase(path: string, options: { readOnly?: boolean } = {}) {
  if (options.readOnly) return new DatabaseSync(path, { readOnly: true });
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
  // 嵌套事务必须支持，不能只靠「大家都别嵌套」的纪律。
  //
  // 最外层用 BEGIN IMMEDIATE：提前拿写锁，防并发下的「检查-再写」双插
  // （投稿去重、限流预占都依赖这一点）。
  // 内层用 SAVEPOINT：SQLite 原生支持嵌套，内层回滚只撤销自己那一段，
  // 不会把外层一起带走。裸 BEGIN 嵌套会抛 SQL logic error，而外层 catch
  // 里那句 ROLLBACK 会把**外层未提交的写入全部丢掉**，还会把本应回滚的
  // 记录继续写下去——比直接报错更糟。
  let depth = 0;
  return new Store(db as unknown as SqlDatabase, action => {
    if (depth > 0) {
      const savepoint = `nested_${depth}`;
      depth += 1;
      db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = action();
        db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        // 内层失败只回滚自己这一段。ROLLBACK TO 之后 savepoint 仍然存在，
        // 必须再 RELEASE 释放，否则会一直挂在事务栈上。
        try { db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`); } catch { /* 外层已回滚，忽略 */ }
        throw error;
      } finally {
        depth -= 1;
      }
    }
    db.exec('BEGIN IMMEDIATE');
    depth = 1;
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      depth = 0;
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
  const app = buildApp(store, now, { secureCookie: cookieSecure, syncToken: usable, inviteCodes, trustedProxies, webRoot: options.webRoot });
  if (options.webRoot) mountWeb(app, options.webRoot);
  return { app, db, store };
}
