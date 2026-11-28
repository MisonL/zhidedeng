import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogImportRequest } from '@zhidedeng/shared';
import { createApp } from '../src/node-app.ts';

const TOKEN = 'audit-ip-token-0123456789abcdefgh';
const admin = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const clock = () => new Date('2026-11-07T05:00:00Z');

let server: ReturnType<typeof createApp>;
beforeEach(() => { server = createApp({ dbPath: ':memory:', now: clock, syncToken: TOKEN }); });
afterEach(() => server.db.close());

const payload = {
  name: '审计站', description: '验证来源地址', url: 'https://audit.example.com/',
  rechargeThreshold: null, paymentMethods: [], offers: [{ modelSlug: 'gpt-4-1', rate: 0.5 }],
};
const body = JSON.stringify({ kind: 'station', channel: 'agent', originKey: 'audit.example.com', payload });

/** Hono 的 app.request 第三个参数可以注入 env，这里模拟真实的 socket 直连地址。 */
const enqueue = async (forwarded: string | null, remoteAddress?: string) => {
  const response = await server.app.request(
    '/api/admin/submissions',
    { method: 'POST', headers: { ...admin, ...(forwarded === null ? {} : { 'x-forwarded-for': forwarded }) }, body },
    remoteAddress ? { incoming: { socket: { remoteAddress } } } : {},
  );
  expect(response.status).toBe(200);
  return (server.db.prepare('SELECT ip FROM submissions ORDER BY rowid DESC LIMIT 1').get() as { ip: string }).ip;
};

describe('入队时记录来源地址', () => {
  it('直连时忽略可以伪造的 X-Forwarded-For', async () => {
    // 客户端自己带头，但直连地址不是本机反代，应当以 TCP 层为准
    expect(await enqueue('203.0.113.9', '198.51.100.2')).toBe('198.51.100.2');
  });

  it('来自本机 nginx 时取 X-Forwarded-For 的最后一项', async () => {
    // nginx 会把真实客户端追加在末尾，前面的部分是客户端自己填的
    expect(await enqueue('1.2.3.4, 203.0.113.7', '127.0.0.1')).toBe('203.0.113.7');
  });

  it('IPv6 映射地址归一化成 IPv4', async () => {
    expect(await enqueue(null, '::ffff:198.51.100.8')).toBe('198.51.100.8');
  });
});
