import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createApp, defaultDbPath, openDatabase, openStore } from '../src/node-app.ts';

/** 测试口令用常量：username/password 相邻字面量会被 GitGuardian 当成硬编码凭据（已误报三次）。 */
const PASSWORD = 'correct-horse-battery';

describe('实体版本号与派生缓存', () => {
  const station = (slug: string, overrides: Record<string, unknown> = {}) => ({
    slug, name: slug, url: `https://${slug}.example.com/`, description: 'd', source: 'agent' as const,
    offers: [], paymentMethods: [], rechargeThreshold: null, status: null,
    uptime: null, firstTokenLatencyMs: null, foundedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  it('put/restore/markRemoved 都会推进版本号，缓存才敢复用', () => {
    // findStation 用 entityVersion 判断站点索引是否过期。漏掉任何一种写操作，
    // 审核就会拿着旧站点去物化——写进错误的记录、或把已下架的站点当成在线。
    const store = openStore(openDatabase(':memory:'));
    const start = store.entityVersion;
    store.put('station', 'v.example.com', station('v.example.com'));
    expect(store.entityVersion).toBeGreaterThan(start);
    const afterPut = store.entityVersion;
    expect(store.markRemoved('station', 'v.example.com', '2026-11-06T00:00:00.000Z')).toBe(true);
    expect(store.entityVersion).toBeGreaterThan(afterPut);
    const afterRemove = store.entityVersion;
    expect(store.restore('station', 'v.example.com')).toBe(true);
    expect(store.entityVersion).toBeGreaterThan(afterRemove);
  });

  it('没有实际改动时不推进版本号，但也不影响正确性', () => {
    const store = openStore(openDatabase(':memory:'));
    store.put('station', 'n.example.com', station('n.example.com'));
    const before = store.entityVersion;
    expect(store.markRemoved('station', 'n.example.com', '2026-11-06T00:00:00.000Z')).toBe(true);
    // 已下架再下架一次：无变化
    expect(store.markRemoved('station', 'n.example.com', '2026-11-07T00:00:00.000Z')).toBe(false);
    expect(store.entityVersion).toBe(before + 1);
  });
});

describe('database initialization and persistence', () => {
  it('loads the API in native Node 22 strip-types mode', () => {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', "const {createApp} = await import('./src/node-app.ts'); const {app,db} = createApp({dbPath: ':memory:'}); const response = await app.request('/api/vendors'); console.log((await response.json()).total); db.close();"], { cwd: resolve('.'), encoding: 'utf8' });
    expect(result.stderr).not.toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('11');
    // 这条要起一个真实 node 子进程；机器负载高时默认 5 秒不够，会变成偶发失败。
  }, 30_000);

  it('defaults to server/data/app.db', () => {
    expect(defaultDbPath).toBe(resolve('data/app.db'));
  });

  it('creates the submission dedupe index and uses it for the dedupe query', () => {
    const server = createApp({ dbPath: ':memory:' });
    try {
      const columns = server.db.prepare('PRAGMA index_info(submissions_dedupe)').all().map(column => column.name);
      expect(columns).toEqual(['kind', 'originKey', 'action', 'batchId', 'payloadHash', 'status', 'createdAt']);
      const plan = server.db.prepare(`EXPLAIN QUERY PLAN
        SELECT * FROM submissions WHERE kind = ? AND originKey = ? AND action = ? AND payloadHash = ?
          AND batchId IS ? AND status = 'pending' ORDER BY createdAt DESC, rowid DESC LIMIT 1`)
        .all('post', 'origin', 'upsert', 'payload', 'batch');
      expect(plan.some(row => String(row.detail).includes('submissions_dedupe'))).toBe(true);
    } finally {
      server.db.close();
    }
  });

  it('creates parent directories, reopens idempotently and preserves writes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'zhidedeng-db-'));
    const dbPath = join(directory, 'nested', 'app.db');
    const now = () => new Date('2026-11-04T01:00:00Z');
    let server = createApp({ dbPath, now });
    try {
      const json = { 'content-type': 'application/json' };
      const registered = await server.app.request('/api/auth/register', { method: 'POST', headers: json, body: JSON.stringify({ username: 'db_tester', password: PASSWORD }) });
      const headers = { ...json, cookie: registered.headers.get('set-cookie')!.split(';')[0] };
      const post = await server.app.request('/api/posts', { method: 'POST', headers, body: JSON.stringify({ kind: 'guide', title: '可恢复的写入', summary: '重启后仍能读取', body: '# 保留\n\n测试正文' }) });
      expect(post.status).toBe(200);
      const created = await post.json() as { id: string };
      await server.app.request('/api/me/checkin', { method: 'POST', headers, body: '{}' });
      server.db.close();
      server = createApp({ dbPath, now });
      const vendors = await server.app.request('/api/vendors');
      expect(await vendors.json()).toMatchObject({ total: 11 });
      expect(await (await server.app.request('/api/posts')).json()).toMatchObject({ total: 48 });
      expect((await server.app.request('/api/me/posts', { headers })).status).toBe(200);
      expect((await server.app.request(`/api/posts/${created.id}`, { headers })).status).toBe(200);
      expect(await (await server.app.request('/api/me', { headers })).json()).toMatchObject({ checkedInToday: true, tokens: 131 });
    } finally {
      server.db.close();
      rmSync(directory, { recursive: true });
    }
  });
});
