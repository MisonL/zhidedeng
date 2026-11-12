import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/node-app.ts';
import { isTrustedProxy } from '../src/app.ts';

const json = { 'content-type': 'application/json' };
// 复用 auth.test.ts 的约定。之前这里写了一个大小写+数字+符号的字面量，
// 被 GitGuardian 当成真实口令告警——测试夹具不该长得像真凭据。
const PASSWORD = 'correct-horse-battery';
let clock: Date;

beforeEach(() => { clock = new Date('2026-11-06T01:00:00Z'); });

function attempt(remote: string, forwarded: string) {
  const server = createApp({ dbPath: ':memory:', now: () => clock, trustedProxies: '172.16.0.0/12' });
  const request = (index: number) => server.app.request('/api/auth/login', {
    method: 'POST',
    headers: { ...json, 'x-forwarded-for': forwarded },
    body: JSON.stringify({ username: `nobody${index}`, password: 'wrong-password' }),
  }, { incoming: { socket: { remoteAddress: remote } } });
  return { server, request };
}

describe('可信反向代理', () => {
  it('回环始终可信', () => {
    expect(isTrustedProxy('127.0.0.1', '')).toBe(true);
    expect(isTrustedProxy('::1', '')).toBe(true);
    expect(isTrustedProxy('::ffff:127.0.0.1', '')).toBe(true);
  });

  it('按 CIDR 判断网段', () => {
    expect(isTrustedProxy('172.17.0.1', '172.16.0.0/12')).toBe(true);
    expect(isTrustedProxy('172.31.255.254', '172.16.0.0/12')).toBe(true);
    expect(isTrustedProxy('172.32.0.1', '172.16.0.0/12')).toBe(false);
    expect(isTrustedProxy('10.0.0.5', '172.16.0.0/12')).toBe(false);
  });

  it('支持单个 IP 与多个条目', () => {
    expect(isTrustedProxy('10.0.0.5', '10.0.0.5')).toBe(true);
    expect(isTrustedProxy('10.0.0.6', '10.0.0.5')).toBe(false);
    expect(isTrustedProxy('10.0.0.6', '10.0.0.5, 10.0.0.6')).toBe(true);
  });

  it('跨全网的 /0 能匹配任意地址，非法条目不会误判', () => {
    expect(isTrustedProxy('203.0.113.9', '0.0.0.0/0')).toBe(true);
    expect(isTrustedProxy('203.0.113.9', 'not-an-ip')).toBe(false);
    expect(isTrustedProxy('203.0.113.9', '10.0.0.0/99')).toBe(false);
    expect(isTrustedProxy(undefined, '10.0.0.0/8')).toBe(false);
  });

  it('不可信来源伪造 X-Forwarded-For 也无法绕过限流', async () => {
    // 直连方是公网地址，头部里的 198.51.100.x 不该被采信，
    // 否则换一个头就换一个限流桶，30 次上限形同虚设。
    const { request } = attempt('203.0.113.7', '198.51.100.1');
    for (let index = 0; index < 30; index += 1) {
      const response = await request(index);
      expect(response.status).toBe(401);
    }
    // 第 31 次：仍然按 203.0.113.7 计数，触发单 IP 上限。
    expect((await request(99)).status).toBe(429);
    // 30 次登录各要跑一次密码校验，默认 5 秒不够。
  }, 60_000);

  it('可信来源的 X-Forwarded-For 会被采信，不同来源各算各的', async () => {
    const server = createApp({ dbPath: ':memory:', now: () => clock, trustedProxies: '172.16.0.0/12' });
    const one = async (forwarded: string, index: number) => server.app.request('/api/auth/login', {
      method: 'POST',
      headers: { ...json, 'x-forwarded-for': forwarded },
      body: JSON.stringify({ username: `user${index}`, password: 'wrong-password' }),
    }, { incoming: { socket: { remoteAddress: '172.17.0.1' } } });

    // 同一个声称来源连续 30 次后触发上限。
    for (let index = 0; index < 30; index += 1) expect((await one('198.51.100.1', index)).status).toBe(401);
    expect((await one('198.51.100.1', 99)).status).toBe(429);
    // 换一个来源则是新的桶——这正是修好之后应有的行为。
    expect((await one('198.51.100.2', 100)).status).toBe(401);
  }, 60_000);
});

describe('无请求体的写接口', () => {
  it('DELETE 不带 Content-Type 也能通过（本来就没有正文要校验）', async () => {
    const server = createApp({ dbPath: ':memory:', now: () => clock });
    const response = await server.app.request('/api/account/agent-tokens/00000000-0000-0000-0000-000000000000', {
      method: 'DELETE',
    }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
    // 未登录的 401 优先于媒体类型检查——重点是它不再是 415。
    expect(response.status).toBe(401);
  });

  it('带请求体的写接口缺 Content-Type 仍被拒（防跨站表单）', async () => {
    const server = createApp({ dbPath: ':memory:', now: () => clock });
    const response = await server.app.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'x', password: 'y' }),
    }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
    expect(response.status).toBe(415);
  });
});

describe('cookie 的 Secure 标记', () => {
  const login = async (server: ReturnType<typeof createApp>, headers: Record<string, string> = {}) => {
    const response = await server.app.request('/api/auth/register', {
      method: 'POST',
      headers: { ...json, ...headers },
      body: JSON.stringify({ username: 'cookieuser', password: PASSWORD }),
    }, { incoming: { socket: { remoteAddress: '172.17.0.1' } } });
    return response.headers.get('set-cookie') ?? '';
  };

  it('生产 + 开启 TLS + 反代声明 https 时带 Secure', async () => {
    const server = createApp({ dbPath: ':memory:', now: () => clock, trustedProxies: '172.16.0.0/12', secureCookie: true });
    expect(await login(server, { 'x-forwarded-proto': 'https' })).toContain('Secure');
  });

  it('开了 TLS 就一律带 Secure，不因代理未配置而静默降级', async () => {
    // 早先要求「直连方是可信反代」才加 Secure，TLS_ENABLED=1 但 TRUSTED_PROXIES
    // 没配时会降级成不带 Secure，HTTPS 站点上的会话 cookie 就随明文请求一起发出去。
    const server = createApp({ dbPath: ':memory:', now: () => clock, secureCookie: true });
    expect(await login(server, { 'x-forwarded-proto': 'http' })).toContain('Secure');
  });

  it('Secure 不再取决于请求头：伪造 X-Forwarded-Proto 也改不了结果', async () => {
    // 两个方向都钉住：没开 TLS 时不带 Secure（伪造 https 也不行），
    // 开了 TLS 时一定带（伪造 http 也不行）。
    const insecure = createApp({ dbPath: ':memory:', now: () => clock, trustedProxies: '172.16.0.0/12' });
    const forged = await insecure.app.request('/api/auth/register', {
      method: 'POST',
      headers: { ...json, 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ username: 'untrusted', password: PASSWORD }),
    }, { incoming: { socket: { remoteAddress: '203.0.113.7' } } });
    expect(forged.headers.get('set-cookie') ?? '').not.toContain('Secure');

    const secure = createApp({ dbPath: ':memory:', now: () => clock, secureCookie: true });
    const downgrade = await secure.app.request('/api/auth/register', {
      method: 'POST',
      headers: { ...json, 'x-forwarded-proto': 'http' },
      body: JSON.stringify({ username: 'downgrade', password: PASSWORD }),
    }, { incoming: { socket: { remoteAddress: '203.0.113.7' } } });
    expect(downgrade.headers.get('set-cookie') ?? '').toContain('Secure');
  });

  it('没开 TLS 时本机 http 能正常拿到 cookie', async () => {
    const server = createApp({ dbPath: ':memory:', now: () => clock });
    expect(await login(server)).not.toContain('Secure');
  });
});
