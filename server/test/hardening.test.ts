import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser, Post } from '@zhidedeng/shared';
import { normalizeIp } from '../src/app.ts';
import { ConcurrencyGate } from '../src/auth.ts';
import { Store } from '../src/database.ts';
import { createApp } from '../src/node-app.ts';

const json = { 'content-type': 'application/json' };
const PASSWORD = 'correct-horse-battery';
const TOKEN = 'admin-token-for-tests-0123456789abcdef';
const admin = { ...json, authorization: `Bearer ${TOKEN}` };

let clock: Date;
let server: ReturnType<typeof createApp>;
beforeEach(() => {
  clock = new Date('2026-11-06T01:00:00Z');
  server = createApp({ dbPath: ':memory:', now: () => clock, syncToken: TOKEN });
});
afterEach(() => server.db.close());

const proxied = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const post = (path: string, body: unknown, ip = '203.0.113.1', cookie = '') =>
  server.app.request(path, { method: 'POST', headers: { ...json, 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }, proxied);
const login = (username: string, password: string, ip = '203.0.113.1') => post('/api/auth/login', { username, password }, ip);

async function register(username: string, password = PASSWORD) {
  const response = await post('/api/auth/register', { username, password }, `198.51.100.${username.length}`);
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}
const statuses = (responses: Response[]) => responses.map(r => r.status).sort();

describe('登录限制', () => {
  it('同一用户名换 IP 失败 20 次后也被拒，正确密码同样被挡，窗口过后恢复', async () => {
    await register('alice');
    for (let index = 0; index < 20; index++) expect((await login('alice', 'wrong-password', `203.0.113.${index}`)).status).toBe(401);
    const limited = await login('alice', PASSWORD, '203.0.113.200');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    clock = new Date(clock.getTime() + 15 * 60_000 + 1000);
    expect((await login('alice', PASSWORD, '203.0.113.200')).status).toBe(200);
  }, 60_000);

  it('用户名大小写不能绕过全局计数', async () => {
    await register('alice');
    for (let index = 0; index < 20; index++) await login(index % 2 ? 'ALICE' : 'alice', 'wrong-password', `203.0.113.${index}`);
    expect((await login('aLiCe', PASSWORD, '203.0.113.200')).status).toBe(429);
  }, 60_000);

  it('并发猜测不能越过限制：同 IP 同用户名一次发 12 个，最多 5 个进入密码校验', async () => {
    await register('alice');
    const results = await Promise.all(Array.from({ length: 12 }, () => login('alice', 'wrong-password')));
    expect(statuses(results).filter(status => status === 401)).toHaveLength(5);
    expect(statuses(results).filter(status => status === 429)).toHaveLength(7);
    expect((await login('alice', PASSWORD)).status).toBe(429);
  }, 30_000);

  it('成功登录释放预占，不算失败', async () => {
    await register('alice');
    // 超过按用户名（20）和按 IP（30）的上限，全部成功说明预占都释放了。
    for (let index = 0; index < 32; index++) expect((await login('alice', PASSWORD)).status).toBe(200);
  }, 30_000);
});

describe('IP 归一化', () => {
  it.each([
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:DB8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['::ffff:203.0.113.5', '203.0.113.5'],
    ['203.0.113.5', '203.0.113.5'],
    ['unknown', 'unknown'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeIp(input)).toBe(expected);
  });

  it('同一 /64 里换地址不能绕过按 IP 的登录限制', async () => {
    await register('alice');
    for (let index = 0; index < 5; index++) await login('alice', 'wrong-password', `2001:db8:1:2::${index + 1}`);
    expect((await login('alice', PASSWORD, '2001:db8:1:2::ffff')).status).toBe(429);
    expect((await login('alice', PASSWORD, '2001:db8:1:3::1')).status).toBe(200);
  }, 30_000);
});

describe('弱密码', () => {
  it.each(['12345678', 'password', 'PASSWORD', 'qwerty123', '11111111', 'password123'])('注册拒绝 %s', async password => {
    const response = await post('/api/auth/register', { username: 'alice', password });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'WEAK_PASSWORD' } });
  });
});

describe('scrypt 并发上限', () => {
  it('同时运行不超过上限，排队按序执行，队列满时返回 503', async () => {
    const gate = new ConcurrencyGate(2, 2);
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const task = () => gate.run(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>(done => releases.push(done));
      running--;
      return 'done';
    });
    const accepted = [task(), task(), task(), task()];
    await expect(task()).rejects.toMatchObject({ status: 503, code: 'BUSY' });
    while (releases.length || running) {
      releases.shift()?.();
      await new Promise(done => setTimeout(done, 0));
    }
    expect(await Promise.all(accepted)).toEqual(['done', 'done', 'done', 'done']);
    expect(peak).toBe(2);
  });

  it('任务失败时释放名额', async () => {
    const gate = new ConcurrencyGate(1, 0);
    await expect(gate.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await gate.run(async () => 'ok')).toBe('ok');
  });

  it('登录并发过高时部分返回 503，被拒的请求不占失败次数', async () => {
    await register('alice');
    const results = await Promise.all(Array.from({ length: 40 }, (_, index) => login(`user${index}`, 'wrong-password', `203.0.113.${index}`)));
    expect(statuses(results)).toContain(503);
    expect(statuses(results)).toContain(401);
    const rejected = results.findIndex(result => result.status === 503);
    for (let index = 0; index < 5; index++) expect((await login(`user${rejected}`, 'wrong-password', `203.0.113.${rejected}`)).status).toBe(401);
  }, 60_000);
});

describe('投稿限制', () => {
  const newPost = (title: string) => ({ kind: 'guide', title, summary: 's', body: 'b' });

  it('每账号每小时最多 10 篇，下一小时恢复，不影响别的账号', async () => {
    const alice = await register('alice');
    for (let index = 0; index < 10; index++) expect((await post('/api/posts', newPost(`t${index}`), '203.0.113.1', alice)).status).toBe(200);
    const limited = await post('/api/posts', newPost('超额'), '203.0.113.1', alice);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect((await post('/api/posts', newPost('别人的'), '203.0.113.2', await register('bobby'))).status).toBe(200);
    clock = new Date(clock.getTime() + 3601_000);
    expect((await post('/api/posts', newPost('一小时后'), '203.0.113.1', alice)).status).toBe(200);
  }, 30_000);

  it('待审超过 20 篇后拒绝；审核掉之后可以继续', async () => {
    const alice = await register('alice');
    const ids: string[] = [];
    for (let index = 0; index < 20; index++) {
      clock = new Date(clock.getTime() + 361_000);
      const response = await post('/api/posts', newPost(`t${index}`), '203.0.113.1', alice);
      expect(response.status).toBe(200);
      ids.push((await response.json() as Post).id);
    }
    clock = new Date(clock.getTime() + 3601_000);
    const limited = await post('/api/posts', newPost('超额'), '203.0.113.1', alice);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: 'PENDING_LIMIT' } });
    await server.app.request(`/api/admin/posts/${ids[0]}/review`, { method: 'POST', headers: admin, body: '{"status":"rejected"}' });
    expect((await post('/api/posts', newPost('腾出位置后'), '203.0.113.1', alice)).status).toBe(200);
  }, 30_000);

  it('shareCount 不再全表读文章', async () => {
    const alice = await register('alice');
    await post('/api/posts', newPost('t'), '203.0.113.1', alice);
    const all = vi.spyOn(Store.prototype, 'all');
    const response = await server.app.request('/api/me', { headers: { cookie: alice } });
    expect(await response.json() as CurrentUser).toMatchObject({ shareCount: 1 });
    expect(all).not.toHaveBeenCalledWith('post');
    all.mockRestore();
  });
});

describe('管理密钥', () => {
  it('SYNC_TOKEN 不足 32 位视为未配置并告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const weak = createApp({ dbPath: ':memory:', syncToken: 'short-token' });
    try {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('SYNC_TOKEN'));
      expect(String(warn.mock.calls[0][0])).not.toContain('short-token');
      const response = await weak.app.request('/api/admin/posts?status=pending', { headers: { authorization: 'Bearer short-token' } });
      expect(response.status).toBe(403);
    } finally {
      weak.db.close();
      warn.mockRestore();
    }
  });

  it('长度足够时可用且不告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const strong = createApp({ dbPath: ':memory:', syncToken: 'x'.repeat(32) });
    try {
      expect(warn).not.toHaveBeenCalled();
      expect((await strong.app.request('/api/admin/posts?status=pending', { headers: { authorization: `Bearer ${'x'.repeat(32)}` } })).status).toBe(200);
    } finally {
      strong.db.close();
      warn.mockRestore();
    }
  });
});

describe('审核群友提交', () => {
  it('对 source=submission 的文章返回 409，状态不变', async () => {
    const body = {
      stations: [{ slug: 'sub-a-com', name: '站', description: 'd', url: 'https://a.com/', rechargeThreshold: null, paymentMethods: [], offers: [] }],
      posts: [{ recordId: 'rec1', stationSlug: 'sub-a-com', title: 't', summary: 's', body: 'b', authorName: '群友', publishedAt: '2026-11-04T08:00:00.000Z' }],
    };
    expect((await server.app.request('/api/admin/import', { method: 'POST', headers: admin, body: JSON.stringify(body) })).status).toBe(200);
    const response = await server.app.request('/api/admin/posts/feishu-rec1/review', { method: 'POST', headers: admin, body: '{"status":"rejected"}' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'MANAGED_BY_SOURCE', message: expect.stringContaining('飞书') } });
    expect((await server.app.request('/api/posts/feishu-rec1')).status).toBe(200);
  });
});

describe('改密码', () => {
  const change = (currentPassword: string, newPassword: string, cookie: string) => post('/api/auth/password', { currentPassword, newPassword }, '203.0.113.1', cookie);
  const me = (cookie: string) => server.app.request('/api/me', { headers: { cookie } });

  it('未登录 401', async () => {
    expect((await post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'another-horse-battery' })).status).toBe(401);
  });

  it('旧密码错误 400 WRONG_PASSWORD，密码不变', async () => {
    const alice = await register('alice');
    const response = await change('wrong-password', 'another-horse-battery', alice);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'WRONG_PASSWORD' } });
    expect((await login('alice', PASSWORD)).status).toBe(200);
  });

  it('成功后：新密码可登录、旧密码不行、当前会话有效、其他会话失效', async () => {
    const alice = await register('alice');
    const other = (await login('alice', PASSWORD)).headers.get('set-cookie')!.split(';')[0];
    expect((await me(other)).status).toBe(200);
    const response = await change(PASSWORD, 'another-horse-battery', alice);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect((await me(alice)).status).toBe(200);
    expect((await me(other)).status).toBe(401);
    expect((await login('alice', PASSWORD)).status).toBe(401);
    expect((await login('alice', 'another-horse-battery')).status).toBe(200);
  });

  it.each([['1234567', 400], ['12345678', 400]])('新密码 %s 被拒', async (newPassword, status) => {
    const alice = await register('alice');
    expect((await change(PASSWORD, newPassword, alice)).status).toBe(status);
    expect((await login('alice', PASSWORD)).status).toBe(200);
  });

  it('旧密码连错 5 次后 429，防止偷到会话的人暴力试密码', async () => {
    const alice = await register('alice');
    for (let index = 0; index < 5; index++) await change('wrong-password', 'another-horse-battery', alice);
    expect((await change(PASSWORD, 'another-horse-battery', alice)).status).toBe(429);
  }, 30_000);
});

describe('禁用账号', () => {
  const disable = (handle: string, disabled: boolean, headers: Record<string, string> = admin) =>
    server.app.request(`/api/admin/users/${handle}/disable`, { method: 'POST', headers, body: JSON.stringify({ disabled }) });

  it('需要管理密钥', async () => {
    await register('alice');
    expect((await disable('alice', true, json)).status).toBe(401);
    expect((await disable('alice', true, { ...json, authorization: 'Bearer wrong' })).status).toBe(403);
  });

  it('不存在的账号和没有账号的种子用户 404', async () => {
    expect((await disable('nobody', true)).status).toBe(404);
    expect((await disable('demo-pedal', true)).status).toBe(404);
  });

  it('禁用后：会话全部失效、不能登录、不能写，公开内容保留；错误文案不暴露禁用状态；恢复后可重新登录', async () => {
    const alice = await register('Alice');
    const comment = await post('/api/comments', { targetType: 'post', targetId: 'post-1', content: '公开内容' }, '203.0.113.1', alice);
    expect(comment.status).toBe(200);

    const response = await disable('aLiCe', true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ handle: 'Alice', disabled: true });

    expect((await server.app.request('/api/me', { headers: { cookie: alice } })).status).toBe(401);
    expect((await post('/api/me/checkin', {}, '203.0.113.1', alice)).status).toBe(401);
    const denied = await login('alice', PASSWORD, '203.0.113.2');
    const missing = await login('nobody', PASSWORD, '203.0.113.2');
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual(await missing.json());
    expect(JSON.stringify(await (await server.app.request('/api/comments?targetType=post&targetId=post-1')).json())).toContain('公开内容');

    await disable('alice', false);
    expect((await server.app.request('/api/me', { headers: { cookie: alice } })).status).toBe(401);
    expect((await login('alice', PASSWORD, '203.0.113.3')).status).toBe(200);
  }, 30_000);

  it('会话表被保留时 sessionHandle 也检查禁用状态', async () => {
    const alice = await register('alice');
    server.db.prepare("UPDATE accounts SET disabledAt = '2026-11-06T00:00:00Z' WHERE handle = 'alice'").run();
    expect((await server.app.request('/api/me', { headers: { cookie: alice } })).status).toBe(401);
  });
});

describe('数据目录权限', () => {
  it('自动创建的目录是 0700', () => {
    const directory = mkdtempSync(join(tmpdir(), 'zhidedeng-mode-'));
    const opened = createApp({ dbPath: join(directory, 'a', 'b', 'app.db') });
    try {
      expect(statSync(join(directory, 'a')).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, 'a', 'b')).mode & 0o777).toBe(0o700);
    } finally {
      opened.db.close();
      rmSync(directory, { recursive: true });
    }
  });
});
