import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser, Post, StationDetail } from '@zhidedeng/shared';
import { normalizeIp } from '../src/app.ts';
import { ConcurrencyGate } from '../src/auth.ts';
import { Store } from '../src/database.ts';
import { createApp, openStore } from '../src/node-app.ts';
import { enqueueSubmission, removeStation, reviewSubmission, submissionState } from '../src/submissions.ts';

const json = { 'content-type': 'application/json' };
const PASSWORD = 'correct-horse-battery';
// 改密用的新口令。写成字面量会被 GitGuardian 判成硬编码口令。
const NEXT_PASSWORD = 'another-correct-horse-battery';
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

  it('成功登录也计入按账号的配额，单人拿自己账号刷不穿密码校验闸门', async () => {
    await register('alice');
    // 按账号这一维不退：退掉的话任何注册用户拿自己的正确密码循环打登录，
    // 就能一直占住密码校验的并发闸门（2 执行 + 16 排队），把登录、注册、
    // 改密一起打成 503，代价只是一个自建账号。
    for (let index = 0; index < 20; index++) expect((await login('alice', PASSWORD)).status).toBe(200);
    expect((await login('alice', PASSWORD)).status).toBe(429);
  }, 30_000);

  it('按 IP 的配额在成功后退还，共用出口 IP 的人不会被邻居拖累', async () => {
    // 办公室、学校、运营商 CGNAT 后面几十个人共用一个出口 IP。
    // 按 IP 这一维若不退，5 个人各登录 6 次就用光 30 次/15 分钟，
    // 第 31 次起整个 IP 的人都要 429——无论密码对错。
    for (const name of ['nat_a', 'nat_b', 'nat_c', 'nat_d', 'nat_e']) await register(name);
    for (let round = 0; round < 6; round++) {
      for (const name of ['nat_a', 'nat_b', 'nat_c', 'nat_d', 'nat_e']) {
        expect((await login(name, PASSWORD)).status).toBe(200);
      }
    }
    // 第 31 次仍然成功：这一维已经被成功登录退回去了。
    expect((await login('nat_a', PASSWORD)).status).toBe(200);
  }, 60_000);

  it('成功登录清掉该 IP 对该账号的失败计数，不会被自己之前的失误挡住', async () => {
    await register('alice');
    // 先猜错 4 次（上限 5），再登录成功应当把这一维清空。
    for (let index = 0; index < 4; index++) expect((await login('alice', 'wrong-password-1')).status).toBe(401);
    expect((await login('alice', PASSWORD)).status).toBe(200);
    // 清空后又能再猜 4 次，而不是紧接着就被挡。
    for (let index = 0; index < 4; index++) expect((await login('alice', 'wrong-password-1')).status).toBe(401);
  }, 30_000);
});

describe('IP 限流键归一化', () => {
  // 限流键就是 IP 字符串。同一个地址只要能写出多个字符串形态，就多出几个桶，
  // 换个写法就把配额重置了——实测轮换前导零/端口/尾点能 14/14 全过注册上限。
  it.each([
    ['198.51.100.7', '前导零不影响'],
    ['0198.51.100.7', '首段前导零'],
    ['198.051.100.007', '多段前导零'],
    ['::ffff:198.51.100.007', 'IPv4 映射形态'],
    ['198.51.100.7.', '尾点'],
    ['198.51.100.7:40000', '带端口'],
    ['198.51.100.7:40001', '换一个端口'],
  ])('%s（%s）归一到同一个键', input => {
    expect(normalizeIp(input)).toBe('198.51.100.7');
  });
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
  it('拒绝群友文章等于下架它，而不是报 409 让管理员去飞书撤销', async () => {
    // 原来这里返回 409 MANAGED_BY_SOURCE，文案是「请到飞书表格撤销通过后重新同步」。
    // 那是条走不通的路：同步脚本只处理审核状态为「通过」的记录，撤销「通过」
    // 只会让这条记录从批次里消失——一个不存在的记录生成不了下架请求。
    // 实测撤销后重同步，文章原样在线。所以拒绝必须真的下架。
    const body = {
      stations: [{ slug: 'sub-a-com', name: '站', description: 'd', url: 'https://a.com/', rechargeThreshold: null, paymentMethods: [], offers: [] }],
      posts: [{ recordId: 'rec1', stationSlug: 'sub-a-com', title: 't', summary: 's', body: 'b', authorName: '群友', publishedAt: '2026-11-04T08:00:00.000Z' }],
    };
    expect((await server.app.request('/api/admin/import', { method: 'POST', headers: admin, body: JSON.stringify(body) })).status).toBe(200);
    expect((await server.app.request('/api/posts/feishu-rec1')).status).toBe(200);
    const response = await server.app.request('/api/admin/posts/feishu-rec1/review', { method: 'POST', headers: admin, body: '{"status":"rejected"}' });
    expect(response.status).toBe(200);
    // 下架后前台立刻看不见
    expect((await server.app.request('/api/posts/feishu-rec1')).status).toBe(404);
  });

  it('下架后重同步不会把文章复活，恢复接口能救回来', async () => {
    // 这是撤稿功能的核心保证。materialize 每次同步都无条件写 status: 'approved'，
    // 没有守卫的话下架等于白做——实测确实会原样回来。
    const body = {
      stations: [{ slug: 'sub-a-com', name: '站', description: 'd', url: 'https://a.com/', rechargeThreshold: null, paymentMethods: [], offers: [] }],
      posts: [{ recordId: 'rec1', stationSlug: 'sub-a-com', title: 't', summary: 's', body: 'b', authorName: '群友', publishedAt: '2026-11-04T08:00:00.000Z' }],
    };
    const sync = async () => server.app.request('/api/admin/import', { method: 'POST', headers: admin, body: JSON.stringify(body) });
    expect((await sync()).status).toBe(200);
    expect((await server.app.request('/api/admin/posts/feishu-rec1/withdraw', { method: 'POST', headers: admin })).status).toBe(200);
    expect((await server.app.request('/api/posts/feishu-rec1')).status).toBe(404);

    // 同内容再同步：仍然不在线
    expect((await sync()).status).toBe(200);
    expect((await server.app.request('/api/posts/feishu-rec1')).status).toBe(404);

    // 重复下架报「已下架」而不是「不存在」——否则管理员以为这篇没了
    const again = await server.app.request('/api/admin/posts/feishu-rec1/withdraw', { method: 'POST', headers: admin });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'ALREADY_REMOVED' } });

    // 恢复后重新可见，正文一直是原样留着的
    expect((await server.app.request('/api/admin/posts/feishu-rec1/restore', { method: 'POST', headers: admin })).status).toBe(200);
    expect((await server.app.request('/api/posts/feishu-rec1')).status).toBe(200);
    // 再恢复一次是 409，不是默默成功
    expect((await server.app.request('/api/admin/posts/feishu-rec1/restore', { method: 'POST', headers: admin })).status).toBe(409);
  });

  it('已下架文章出现在管理端列表里，能查到下架时间', async () => {
    const body = {
      stations: [{ slug: 'sub-a-com', name: '站', description: 'd', url: 'https://a.com/', rechargeThreshold: null, paymentMethods: [], offers: [] }],
      posts: [{ recordId: 'rec1', stationSlug: 'sub-a-com', title: 't', summary: 's', body: 'b', authorName: '群友', publishedAt: '2026-11-04T08:00:00.000Z' }],
    };
    expect((await server.app.request('/api/admin/import', { method: 'POST', headers: admin, body: JSON.stringify(body) })).status).toBe(200);
    expect((await server.app.request('/api/admin/posts/feishu-rec1/withdraw', { method: 'POST', headers: admin })).status).toBe(200);
    const listed = await (await server.app.request('/api/admin/posts/removed', { headers: admin })).json() as { items: { id: string; removedAt: string }[] };
    expect(listed.items.map(item => item.id)).toContain('feishu-rec1');
    expect(listed.items.find(item => item.id === 'feishu-rec1')!.removedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('演示文章不能下架，和站点侧同一套规矩', async () => {
    // removeStation 拒绝 source='demo'：那些是虚构样例，撤掉只会让站点看起来像坏了。
    // 文章这条路径原来没这个守卫，一篇演示文章能被悄悄撤掉、首页出现空位。
    const demo = server.db.prepare("SELECT id FROM entities WHERE kind = 'post' AND json_extract(data,'$.source')='demo' LIMIT 1").get() as { id: string } | undefined;
    expect(demo).toBeDefined();
    const response = await server.app.request(`/api/admin/posts/${demo!.id}/withdraw`, { method: 'POST', headers: admin });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'POST_SOURCE_CONFLICT' } });
    // 状态没被改动
    expect((await server.app.request(`/api/posts/${demo!.id}`)).status).toBe(200);
  });

  it('对还没物化的待审稿下架返回 404，不会悄悄藏掉', async () => {
    // 待审稿只在 submissions 里，实体不存在。这里必须是 404：
    // 若返回成功，作者会在自己的列表里看到稿子凭空消失，管理端也再无入口通过它。
    const cookie = await register('pendingone');
    const created = await (await post('/api/posts', { kind: 'review', title: '待审稿', summary: 's', body: 'b' }, '203.0.113.9', cookie)).json() as { id: string };
    const response = await server.app.request(`/api/admin/posts/${created.id}/withdraw`, { method: 'POST', headers: admin });
    expect(response.status).toBe(404);
    // 作者仍然看得到自己的稿子，管理端也仍然能审核它
    expect((await server.app.request(`/api/posts/${created.id}`, { headers: { cookie } })).status).toBe(200);
    const pending = await (await server.app.request('/api/admin/posts?status=pending', { headers: admin })).json() as { items: { id: string }[] };
    expect(pending.items.map(item => item.id)).toContain(created.id);
  });

  it('旧式导入的文章下架后，走队列同步也不会换个 id 复活', async () => {
    // 同一篇飞书评价可能有两条写入路径：老运维导入建 `feishu-<recordId>`，
    // 队列物化建 `sub-<投稿id>`。materialize 靠「legacy 文章还在不在」来决定
    // 沿用哪个 id，但判断用 store.get——**它看不见已下架的行**。于是下架后
    // legacy 判定失败，物化改用新 id 建出一篇内容一样的新文章，前台又能看到。
    // 软删除挡不住另一个 id，这是真实的复活路径。
    const importBody = {
      stations: [{ slug: 'sub-legacy-com', name: '老站', description: '描述', url: 'https://legacy.com/', rechargeThreshold: null, paymentMethods: [], offers: [] }],
      posts: [{ recordId: 'recLegacy', stationSlug: 'sub-legacy-com', title: '旧式导入的评测', summary: '摘要', body: '正文', authorName: '群友', publishedAt: '2026-11-04T08:00:00.000Z' }],
    };
    expect((await server.app.request('/api/admin/import', { method: 'POST', headers: admin, body: JSON.stringify(importBody) })).status).toBe(200);
    expect((await server.app.request('/api/posts/feishu-recLegacy')).status).toBe(200);

    await server.app.request('/api/admin/posts/feishu-recLegacy/withdraw', { method: 'POST', headers: admin });
    expect((await server.app.request('/api/posts/feishu-recLegacy')).status).toBe(404);

    // 队列同步同一条飞书记录
    const batch = await server.app.request('/api/admin/submissions/batch', {
      method: 'POST', headers: admin,
      body: JSON.stringify({ channel: 'feishu', items: [{ kind: 'post', originKey: 'recLegacy', payload: { recordId: 'recLegacy', title: '队列同步的评测', summary: '摘要', body: '正文', authorName: '群友', publishedAt: '2026-11-04T08:00:00.000Z', hostname: 'legacy.com' } }] }),
    });
    expect(batch.status).toBe(200);
    const pending = server.db.prepare("SELECT id FROM submissions WHERE kind = 'post' AND status = 'pending'").all() as { id: string }[];
    for (const { id } of pending) {
      await server.app.request('/api/admin/submissions/batch-review', { method: 'POST', headers: admin, body: JSON.stringify({ ids: [id], status: 'approved' }) });
    }

    // 不该出现第二篇同一来源的文章
    const submissions = server.db.prepare("SELECT id, removedAt FROM entities WHERE kind = 'post' AND json_extract(data,'$.source') = 'submission'").all() as { id: string; removedAt: string | null }[];
    expect(submissions.map(row => row.id)).toEqual(['feishu-recLegacy']);
    expect(submissions[0]!.removedAt).not.toBeNull();
    const visible = await (await server.app.request('/api/posts?pageSize=100')).json() as { items: { title: string }[] };
    expect(visible.items.map(item => item.title)).not.toContain('队列同步的评测');
  });

  it('队列已物化的文章下架后，运维导入同一条也沿用同一个 id，不会另建一篇', async () => {
    // 反方向的同一个漏洞：先走队列物化（id = sub-<投稿id>），下架后再跑运维导入
    // （id = feishu-<recordId>）。两条路径按不同的规则派生 id，同一个飞书记录
    // 就对应两个实体，软删除只能挡住它认识的那个 id。
    const payload = { recordId: 'recBoth', title: '先队列后导入', summary: '摘要', body: '正文', authorName: '群友', publishedAt: '2026-11-04T08:00:00.000Z', hostname: 'both.example.com' };
    await server.app.request('/api/admin/submissions/batch', {
      method: 'POST', headers: admin,
      body: JSON.stringify({ channel: 'feishu', items: [{ kind: 'post', originKey: 'recBoth', payload }] }),
    });
    const pending = server.db.prepare("SELECT id FROM submissions WHERE kind = 'post' AND status = 'pending'").all() as { id: string }[];
    for (const { id } of pending) {
      await server.app.request('/api/admin/submissions/batch-review', { method: 'POST', headers: admin, body: JSON.stringify({ ids: [id], status: 'approved' }) });
    }
    const materialized = server.db.prepare("SELECT id FROM entities WHERE kind = 'post' AND json_extract(data,'$.source') = 'submission'").all() as { id: string }[];
    expect(materialized).toHaveLength(1);
    const queueId = materialized[0]!.id;
    expect(queueId.startsWith('sub-')).toBe(true);

    await server.app.request(`/api/admin/posts/${queueId}/withdraw`, { method: 'POST', headers: admin });
    expect((await server.app.request(`/api/posts/${queueId}`)).status).toBe(404);

    const importBody = {
      stations: [{ slug: 'sub-both-example-com', name: '同一条站', description: '描述', url: 'https://both.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [] }],
      posts: [{ recordId: 'recBoth', stationSlug: 'sub-both-example-com', title: '先队列后导入', summary: '摘要', body: '正文', authorName: '群友', publishedAt: '2026-11-04T08:00:00.000Z' }],
    };
    expect((await server.app.request('/api/admin/import', { method: 'POST', headers: admin, body: JSON.stringify(importBody) })).status).toBe(200);

    // 还是那一个实体，还是下架状态
    const after = server.db.prepare("SELECT id, removedAt FROM entities WHERE kind = 'post' AND json_extract(data,'$.source') = 'submission'").all() as { id: string; removedAt: string | null }[];
    expect(after.map(row => row.id)).toEqual([queueId]);
    expect(after[0]!.removedAt).not.toBeNull();
    const visible = await (await server.app.request('/api/posts?pageSize=100')).json() as { items: { title: string }[] };
    expect(visible.items.map(item => item.title)).not.toContain('先队列后导入');
  });

  it('下架站点后重新同步，可用率等指标不会被清成 null', async () => {
    // 回归：物化站点时用 `store.get` 取 previous，而它看不见已下架的行。
    // 站点被下架后再同步一次，previous 变成 undefined → 四个指标字段全写 null。
    // 这四项全站没有别的写入入口，写没了就永远补不回来；而「下架后同步会
    // 自动恢复」听起来是好事，实际是拿指标换回来的。
    // catalog.ts 已经踩过同一个坑并专门加了 metrics 快照，submissions.ts 没跟上。
    const station = { slug: 'sub-metrics-example-com', name: '指标站', description: '描述', url: 'https://metrics.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [] };
    const payload = { ...station };
    const enqueue = (batchId: string, now: Date) => enqueueSubmission(openStore(server.db), {
      kind: 'station', channel: 'feishu', originKey: 'metrics.example.com', batchId, action: 'upsert',
      payload, ip: '203.0.113.40', now,
    }, { globalPendingBreaker: false }).submission.id;
    const approve = (id: string, now: Date) => reviewSubmission(openStore(server.db), now, id, { status: 'approved' });
    const seedMetrics = () => server.db.prepare(
      "UPDATE entities SET data = json_set(data,'$.uptime',99.5,'$.firstTokenLatencyMs',320,'$.foundedAt','2024-03-08','$.status','running') WHERE kind = 'station' AND id = ?",
    ).run(station.slug);
    const metrics = () => server.db.prepare(
      "SELECT json_extract(data,'$.uptime') uptime, json_extract(data,'$.firstTokenLatencyMs') latency, json_extract(data,'$.foundedAt') foundedAt, json_extract(data,'$.status') status FROM entities WHERE kind = 'station' AND id = ?",
    ).get(station.slug);

    const firstId = enqueue('metrics-b1', new Date('2026-11-06T00:00:00Z'));
    approve(firstId, new Date('2026-11-06T00:00:00Z'));
    seedMetrics();
    // 下架要带上当初物化它的那条投稿版本（同一次同步不能追加条目，用同一个 id）
    removeStation(openStore(server.db), station.slug, firstId, new Date('2026-11-06T01:00:00Z').toISOString());
    expect((await server.app.request(`/api/stations/${station.slug}`)).status).toBe(404);

    // 飞书里这条还在，下一次同步把它带回来
    approve(enqueue('metrics-b2', new Date('2026-11-07T00:00:00Z')), new Date('2026-11-07T00:00:00Z'));
    expect(await metrics()).toEqual({ uptime: 99.5, latency: 320, foundedAt: '2024-03-08', status: 'running' });
    const detail = await (await server.app.request(`/api/stations/${station.slug}`)).json() as StationDetail;
    expect(detail).toMatchObject({ uptime: 99.5, firstTokenLatencyMs: 320, foundedAt: '2024-03-08', status: 'running' });
  });

  it('站点下架后换 www/裸域 再同步，仍认回同一个站，不另建一条', async () => {
    // 飞书把 www.x.com 与 x.com 当同一个站点（feishuHostnameKey 分组），
    // 但 stationHostIndex 只扫在线站点。站点被下架后，stationSlug 的认领若只做
    // 精确 hostname 比较，换个写法就会被当成全新站点：新建一条指标全 null 的实体，
    // 而旧实体带着可用率躺在「已下架」里——数据没丢，但读者再也看不到。
    const mk = (host: string, batchId: string, now: Date) => enqueueSubmission(openStore(server.db), {
      kind: 'station', channel: 'feishu', originKey: host, batchId, action: 'upsert',
      payload: { slug: 'alias', name: '别名站', description: '描述', url: `https://${host}/`, rechargeThreshold: null, paymentMethods: [], offers: [] },
      ip: '203.0.113.41', now,
    }, { globalPendingBreaker: false }).submission.id;
    const approve = (id: string, now: Date) => reviewSubmission(openStore(server.db), now, id, { status: 'approved' });
    const submissionStations = () => server.db.prepare(
      "SELECT id, json_extract(data,'$.url') url, json_extract(data,'$.uptime') uptime, removedAt FROM entities WHERE kind = 'station' AND json_extract(data,'$.source') = 'submission' ORDER BY rowid",
    ).all() as { id: string; url: string; uptime: number | null; removedAt: string | null }[];

    const first = mk('www.alias-review.example.com', 'alias-b1', new Date('2026-11-06T00:00:00Z'));
    approve(first, new Date('2026-11-06T00:00:00Z'));
    server.db.prepare("UPDATE entities SET data = json_set(data,'$.uptime',99.5) WHERE kind = 'station' AND json_extract(data,'$.source') = 'submission'").run();
    removeStation(openStore(server.db), submissionStations()[0]!.id, first, new Date('2026-11-06T01:00:00Z').toISOString());
    // 中间态必须断言：下架没生效时，后面那次同步走的是「在线索引」路径，
    // 根本没测到「已下架也参与认领」。把 markRemoved 改成空操作，这条用例照样绿。
    expect(submissionStations()[0]!.removedAt).not.toBeNull();

    approve(mk('alias-review.example.com', 'alias-b2', new Date('2026-11-07T00:00:00Z')), new Date('2026-11-07T00:00:00Z'));
    const rows = submissionStations();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'sub-www-alias-review-example-com', uptime: 99.5, removedAt: null });
  });

  it('空批次的单条飞书投稿，换 www/裸域再同步也认回同一个站', async () => {
    // 站点侧的 grouped 认领若仍带 `batchId !== null`，管理端单条（空批次）投稿
    // 就会绕过分组：站点下架后换成 www/裸域写法再同步，被当成新站另建一条，
    // 而旧实体带着指标留在「已下架」里。文章侧早已完全不看 batchId，站点侧同理。
    const mk = (host: string, now: Date) => enqueueSubmission(openStore(server.db), {
      kind: 'station', channel: 'feishu', originKey: host, action: 'upsert',
      payload: { slug: 'alias', name: '空批次站', description: '描述', url: `https://${host}/`, rechargeThreshold: null, paymentMethods: [], offers: [] },
      ip: '203.0.113.42', now,
    }, { globalPendingBreaker: false }).submission.id;   // 故意不给 batchId
    const approve = (id: string, now: Date) => reviewSubmission(openStore(server.db), now, id, { status: 'approved' });
    const rows = () => server.db.prepare(
      "SELECT id, json_extract(data,'$.uptime') uptime, removedAt FROM entities WHERE kind = 'station' AND json_extract(data,'$.source') = 'submission' ORDER BY rowid",
    ).all() as { id: string; uptime: number | null; removedAt: string | null }[];

    const first = mk('www.null-batch.example.com', new Date('2026-11-06T00:00:00Z'));
    approve(first, new Date('2026-11-06T00:00:00Z'));
    server.db.prepare("UPDATE entities SET data = json_set(data,'$.uptime',97.5) WHERE kind = 'station' AND json_extract(data,'$.source') = 'submission'").run();
    removeStation(openStore(server.db), rows()[0]!.id, first, new Date('2026-11-06T01:00:00Z').toISOString());
    expect(rows()[0]!.removedAt).not.toBeNull();

    approve(mk('null-batch.example.com', new Date('2026-11-07T00:00:00Z')), new Date('2026-11-07T00:00:00Z'));
    const after = rows();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: 'sub-www-null-batch-example-com', uptime: 97.5, removedAt: null });
  });

  it('同组里已有精确写法的在线站时，同步更新它，不改写别人的 url', async () => {
    // 飞书把 www 与裸域当同一站，但组里可能已经并存两条在线站（agent 各自建的）。
    // 若认领时「组内取 rowid 第一条」，投 x.com 会选中更早的 www.x.com 并把它的 url
    // 改写成 x.com——两条在线站从此同 url，前端显示两条一模一样的站，另一条再也
    // 不被同步更新、也进不了下架计划。所以精确写法必须优先。
    const seed = (slug: string, name: string, url: string, uptime: number) => server.db.prepare(
      "INSERT INTO entities (kind, id, data) VALUES ('station', ?, ?)",
    ).run(slug, JSON.stringify({ slug, name, description: '描述', url, rechargeThreshold: null, paymentMethods: [], offers: [], status: 'running', uptime, firstTokenLatencyMs: 200, foundedAt: '2023-01-01', source: 'agent' }));
    seed('agent-www-dup.example.com', 'agent www', 'https://www.dup.example.com/', 90.1);
    seed('agent-dup.example.com', 'agent 裸域', 'https://dup.example.com/', 88.8);
    const read = () => server.db.prepare(
      "SELECT id, json_extract(data,'$.url') url, json_extract(data,'$.name') name, json_extract(data,'$.source') source FROM entities WHERE kind = 'station' AND id LIKE 'agent-%dup%' ORDER BY rowid",
    ).all() as { id: string; url: string; name: string; source: string }[];

    const id = enqueueSubmission(openStore(server.db), {
      kind: 'station', channel: 'feishu', originKey: 'dup.example.com', action: 'upsert',
      payload: { slug: 'dup', name: '飞书投稿', description: '飞书描述', url: 'https://dup.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [] },
      ip: '203.0.113.44', now: new Date('2026-11-06T00:00:00Z'),
    }, { globalPendingBreaker: false }).submission.id;
    reviewSubmission(openStore(server.db), new Date('2026-11-06T00:00:00Z'), id, { status: 'approved' });

    const rows = read();
    // 精确写法那条被更新，www 那条一个字都没动
    expect(rows.find(row => row.id === 'agent-dup.example.com')).toMatchObject({ url: 'https://dup.example.com/', name: '飞书投稿', source: 'agent' });
    expect(rows.find(row => row.id === 'agent-www-dup.example.com')).toMatchObject({ url: 'https://www.dup.example.com/', name: 'agent www' });
    // 没有两条在线站同 url
    expect(new Set(rows.map(row => row.url)).size).toBe(rows.length);
  });

  it('同组里早先下架的站不会抢在在线站前面被认领（只更新在线的那条）', async () => {
    // 反过来的错法同样糟：认领按 rowid 取第一条，可能选中一条已下架的 www 站，
    // 于是同步把它复活、却在线的裸域站留着旧内容。两个方向都错。
    const seed = (slug: string, url: string) => server.db.prepare(
      "INSERT INTO entities (kind, id, data) VALUES ('station', ?, ?)",
    ).run(slug, JSON.stringify({ slug, name: '旧名', description: '描述', url, rechargeThreshold: null, paymentMethods: [], offers: [], status: null, uptime: null, firstTokenLatencyMs: null, foundedAt: null, source: 'agent' }));
    seed('agent-www-m.example.com', 'https://www.m.example.com/');
    server.db.prepare("UPDATE entities SET removedAt = '2026-11-05T00:00:00Z' WHERE kind = 'station' AND id = 'agent-www-m.example.com'").run();
    seed('agent-m.example.com', 'https://m.example.com/');
    const read = (slug: string) => server.db.prepare("SELECT json_extract(data,'$.name') name, removedAt FROM entities WHERE kind = 'station' AND id = ?").get(slug) as { name: string; removedAt: string | null };

    const id = enqueueSubmission(openStore(server.db), {
      kind: 'station', channel: 'feishu', originKey: 'm.example.com', action: 'upsert',
      payload: { slug: 'm', name: '飞书投稿', description: '飞书描述', url: 'https://m.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [] },
      ip: '203.0.113.45', now: new Date('2026-11-06T00:00:00Z'),
    }, { globalPendingBreaker: false }).submission.id;
    reviewSubmission(openStore(server.db), new Date('2026-11-06T00:00:00Z'), id, { status: 'approved' });

    expect(read('agent-m.example.com')).toMatchObject({ name: '飞书投稿', removedAt: null });
    expect(read('agent-www-m.example.com')).toMatchObject({ name: '旧名', removedAt: '2026-11-05T00:00:00Z' });
  });

  it('组里两条都已下架时，同步复活精确写法那条，不复活另一条', async () => {
    // 这条才真正打到 stationSlug 的认领（findStation 只扫在线站点，此时它返回
    // undefined）。两条同组的站都在「已下架」里，投裸域就该复活裸域那条：
    // 反过来的话，读者之前收藏的 www 站被复活、裸域站继续躺在已下架里，
    // 两个方向的预期都落空。
    const seedRemoved = (slug: string, url: string) => {
      server.db.prepare("INSERT INTO entities (kind, id, data) VALUES ('station', ?, ?)")
        .run(slug, JSON.stringify({ slug, name: '旧名', description: '描述', url, rechargeThreshold: null, paymentMethods: [], offers: [], status: null, uptime: null, firstTokenLatencyMs: null, foundedAt: null, source: 'submission' }));
      server.db.prepare("UPDATE entities SET removedAt = '2026-11-05T00:00:00Z' WHERE kind = 'station' AND id = ?").run(slug);
    };
    const storeRemoved = (slug: string) => server.db.prepare("SELECT removedAt FROM entities WHERE kind = 'station' AND id = ?").get(slug) as { removedAt: string | null } | undefined;
    seedRemoved('sub-www-k-example-com', 'https://www.k.example.com/');
    seedRemoved('sub-k-example-com', 'https://k.example.com/');
    // 前置状态也要断言：这两条必须真的处于「已下架」，否则下面的终态断言
    // 可能在一个根本没造出前提交件的环境里碰巧通过。
    expect(storeRemoved('sub-www-k-example-com')?.removedAt).not.toBeNull();
    expect(storeRemoved('sub-k-example-com')?.removedAt).not.toBeNull();
    const read = (slug: string) => server.db.prepare("SELECT json_extract(data,'$.name') name, removedAt FROM entities WHERE kind = 'station' AND id = ?").get(slug) as { name: string; removedAt: string | null };

    const id = enqueueSubmission(openStore(server.db), {
      kind: 'station', channel: 'feishu', originKey: 'k.example.com', action: 'upsert',
      payload: { slug: 'k', name: '飞书复活', description: '飞书描述', url: 'https://k.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [] },
      ip: '203.0.113.47', now: new Date('2026-11-06T00:00:00Z'),
    }, { globalPendingBreaker: false }).submission.id;
    reviewSubmission(openStore(server.db), new Date('2026-11-06T00:00:00Z'), id, { status: 'approved' });

    expect(read('sub-k-example-com')).toMatchObject({ name: '飞书复活', removedAt: null });
    expect(read('sub-www-k-example-com')).toMatchObject({ name: '旧名', removedAt: '2026-11-05T00:00:00Z' });
  });

  it('被飞书认领过的 agent 站进入飞书下架计划，飞书删了它才能自动下架', async () => {
    // 站点被认领后 source 仍是 agent（这是有意的：身份不因换渠道而改标）。
    // 但下架计划原先只列 source === 'submission'，于是这类站飞书里删掉后，
    // 自动下架清不掉，只能人工改库。
    const seed = () => server.db.prepare("INSERT INTO entities (kind, id, data) VALUES ('station', ?, ?)")
      .run('agent-plan.example.com', JSON.stringify({ slug: 'agent-plan.example.com', name: '计划站', description: '描述', url: 'https://plan.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [], status: null, uptime: null, firstTokenLatencyMs: null, foundedAt: null, source: 'agent' }));
    seed();
    const id = enqueueSubmission(openStore(server.db), {
      kind: 'station', channel: 'feishu', originKey: 'plan.example.com', action: 'upsert',
      payload: { slug: 'plan', name: '计划站', description: '描述', url: 'https://plan.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [] },
      ip: '203.0.113.46', now: new Date('2026-11-06T00:00:00Z'),
    }, { globalPendingBreaker: false }).submission.id;
    reviewSubmission(openStore(server.db), new Date('2026-11-06T00:00:00Z'), id, { status: 'approved' });
    expect(openStore(server.db).get('station', 'agent-plan.example.com')?.source).toBe('agent');
    const planned = submissionState(openStore(server.db)).stations.find(station => station.slug === 'agent-plan.example.com');
    expect(planned).toBeDefined();

    // 光出现在表里还不够：拿表里的 submissionId 真的下一次架，证明自动下架能落地。
    // 版本号取自「最新一条 approved upsert」，与同步脚本拿到的完全一致。
    const removed = removeStation(openStore(server.db), planned!.slug, planned!.submissionId, new Date('2026-11-08T00:00:00Z').toISOString());
    expect(removed).toBe('agent-plan.example.com');
    expect(openStore(server.db).get('station', 'agent-plan.example.com')).toBeUndefined();
    expect(submissionState(openStore(server.db)).stations.map(station => station.slug)).not.toContain('agent-plan.example.com');
  });

  it('只有已下架的是精确写法时，复活它，不去改写在线 www 站的 url', async () => {
    // 反方向同样会制造「同 url」：在线 www.n + 已下架 n，投 n 时若只看在线站，
    // 会命中 www.n 并把它的 url 改写成 n；此后对 n 调用恢复接口，两条在线站同 url。
    // 精确写法优先且**含已下架**，才能复活 n 而让 www.n 原样不动。
    const seed = (slug: string, url: string, removed: boolean) => {
      server.db.prepare("INSERT INTO entities (kind, id, data) VALUES ('station', ?, ?)")
        .run(slug, JSON.stringify({ slug, name: '旧名', description: '描述', url, rechargeThreshold: null, paymentMethods: [], offers: [], status: 'running', uptime: 91.2, firstTokenLatencyMs: 200, foundedAt: '2023-01-01', source: 'agent' }));
      if (removed) server.db.prepare("UPDATE entities SET removedAt = '2026-11-05T00:00:00Z' WHERE kind = 'station' AND id = ?").run(slug);
    };
    seed('agent-www-n2.example.com', 'https://www.n2.example.com/', false);
    seed('agent-n2.example.com', 'https://n2.example.com/', true);
    const read = (slug: string) => server.db.prepare(
      "SELECT json_extract(data,'$.url') url, json_extract(data,'$.name') name, removedAt FROM entities WHERE kind = 'station' AND id = ?",
    ).get(slug) as { url: string; name: string; removedAt: string | null };

    const id = enqueueSubmission(openStore(server.db), {
      kind: 'station', channel: 'feishu', originKey: 'n2.example.com', action: 'upsert',
      payload: { slug: 'n2', name: '飞书复活', description: '飞书描述', url: 'https://n2.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [] },
      ip: '203.0.113.48', now: new Date('2026-11-06T00:00:00Z'),
    }, { globalPendingBreaker: false }).submission.id;
    reviewSubmission(openStore(server.db), new Date('2026-11-06T00:00:00Z'), id, { status: 'approved' });

    expect(read('agent-n2.example.com')).toMatchObject({ url: 'https://n2.example.com/', name: '飞书复活', removedAt: null });
    // 在线那条一个字都不该动，尤其 url 不能被改写成裸域
    expect(read('agent-www-n2.example.com')).toMatchObject({ url: 'https://www.n2.example.com/', name: '旧名', removedAt: null });
  });

  it('同 url 两条实体里已下架那条 rowid 更小时，同步更新在线那条，不复活旧的', async () => {
    // 库里存在同 url 两条实体是历史产物（早先按分组认领会改写 url、全量导入按给定
    // slug 直接写，都能造出来）。只下架了其中一条时，若让「已下架」与「在线」按
    // rowid 平级去抢，同步会复活已下架那条，于是又变成「两条在线站同 url」——
    // 正是这一串改动要消灭的状态。在线那条才是现在给人看的，必须先更新它。
    const seed = (slug: string, name: string, removed: boolean) => {
      server.db.prepare("INSERT INTO entities (kind, id, data) VALUES ('station', ?, ?)")
        .run(slug, JSON.stringify({ slug, name, description: '描述', url: 'https://dup2.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [], status: null, uptime: null, firstTokenLatencyMs: null, foundedAt: null, source: 'agent' }));
      if (removed) server.db.prepare("UPDATE entities SET removedAt = '2026-11-05T00:00:00Z' WHERE kind = 'station' AND id = ?").run(slug);
    };
    seed('agent-old-removed.example.com', '已下架那条', true);   // rowid 更小
    seed('agent-new-online.example.com', '在线那条', false);
    const read = () => server.db.prepare(
      "SELECT id, json_extract(data,'$.name') name, removedAt FROM entities WHERE kind = 'station' AND id IN ('agent-old-removed.example.com','agent-new-online.example.com') ORDER BY rowid",
    ).all() as { id: string; name: string; removedAt: string | null }[];

    const id = enqueueSubmission(openStore(server.db), {
      kind: 'station', channel: 'feishu', originKey: 'dup2.example.com', action: 'upsert',
      payload: { slug: 'dup2', name: '飞书投稿', description: '飞书描述', url: 'https://dup2.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [] },
      ip: '203.0.113.49', now: new Date('2026-11-06T00:00:00Z'),
    }, { globalPendingBreaker: false }).submission.id;
    reviewSubmission(openStore(server.db), new Date('2026-11-06T00:00:00Z'), id, { status: 'approved' });

    const rows = read();
    expect(rows.filter(row => row.removedAt === null)).toHaveLength(1);
    expect(rows.find(row => row.id === 'agent-new-online.example.com')).toMatchObject({ name: '飞书投稿', removedAt: null });
    expect(rows.find(row => row.id === 'agent-old-removed.example.com')).toMatchObject({ name: '已下架那条', removedAt: '2026-11-05T00:00:00Z' });
  });

  it('同组里在线的是 www 写法、已下架的是裸域时，别名待审仍被替代', async () => {
    // supersedePending 原先拿「含已下架认领到的 target」和「只看在线的
    // groupedTarget」相比：已下架的裸域 rowid 更小时两者不等 → 提前 return，
    // 同组的 www 别名永远留在待审里，审核台白多一条。两边必须用同一张表。
    const seed = (slug: string, url: string, removed: boolean) => {
      server.db.prepare("INSERT INTO entities (kind, id, data) VALUES ('station', ?, ?)")
        .run(slug, JSON.stringify({ slug, name: '旧名', description: '描述', url, rechargeThreshold: null, paymentMethods: [], offers: [], status: null, uptime: null, firstTokenLatencyMs: null, foundedAt: null, source: 'agent' }));
      if (removed) server.db.prepare("UPDATE entities SET removedAt = '2026-11-05T00:00:00Z' WHERE kind = 'station' AND id = ?").run(slug);
    };
    seed('agent-www-q.example.com', 'https://www.q.example.com/', false);   // 在线，rowid 小
    seed('agent-q.example.com', 'https://q.example.com/', true);            // 已下架，rowid 大
    const payload = { slug: 'q', name: '飞书', description: '描述', url: 'https://q.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [] };
    // 别名那条要用**历史行**的方式插：现在的入队接口会立刻把 originKey 规范成
    // payload url 的 hostname，两条投稿就同 originKey，走的是最普通的那条 UPDATE，
    // 根本到不了别名分支。别名分支专门处理「历史 originKey 还留着 www 写法」的行。
    const alias = 'legacy-alias-www-q';
    server.db.prepare(
      "INSERT INTO submissions (id, kind, channel, originKey, batchId, action, payload, payloadHash, ip, status, createdAt) VALUES (?, 'station', 'feishu', 'www.q.example.com', 'qb-alias', 'upsert', ?, 'h', '203.0.113.50', 'pending', '2026-11-06T00:00:00Z')",
    ).run(alias, JSON.stringify(payload));
    const main = enqueueSubmission(openStore(server.db), {
      kind: 'station', channel: 'feishu', originKey: 'q.example.com', batchId: 'qb-main', action: 'upsert', payload,
      ip: '203.0.113.50', now: new Date('2026-11-06T01:00:00Z'),
    }, { globalPendingBreaker: false }).submission.id;

    reviewSubmission(openStore(server.db), new Date('2026-11-06T02:00:00Z'), main, { status: 'approved' });
    const status = (id: string) => (server.db.prepare('SELECT status FROM submissions WHERE id = ?').get(id) as { status: string }).status;
    expect(status(main)).toBe('approved');
    expect(status(alias)).toBe('superseded');
  });

  it('同 hostname 不同路径的两条站在线时，同步按整条地址认领，不把 url 改写成另一条', async () => {
    // 只按 hostname 认领时，取 rowid 第一条会把它的 url 改写成投稿里的路径，
    // 而另一条本来就是这个 url——又变成两条在线站同 url。
    const seed = (slug: string, url: string, removed = false) => {
      server.db.prepare("INSERT INTO entities (kind, id, data) VALUES ('station', ?, ?)")
        .run(slug, JSON.stringify({ slug, name: slug, description: '描述', url, rechargeThreshold: null, paymentMethods: [], offers: [], status: null, uptime: null, firstTokenLatencyMs: null, foundedAt: null, source: 'agent' }));
      if (removed) server.db.prepare("UPDATE entities SET removedAt = '2026-11-05T00:00:00Z' WHERE kind = 'station' AND id = ?").run(slug);
    };
    seed('agent-path-a.example.com', 'https://pathx.example.com/a');
    seed('agent-path-b.example.com', 'https://pathx.example.com/b');
    const read = () => server.db.prepare(
      "SELECT id, json_extract(data,'$.url') url, json_extract(data,'$.name') name, removedAt FROM entities WHERE kind = 'station' AND id IN ('agent-path-a.example.com','agent-path-b.example.com') ORDER BY rowid",
    ).all() as { id: string; url: string; name: string; removedAt: string | null }[];

    const send = (payloadUrl: string) => {
      const id = enqueueSubmission(openStore(server.db), {
        kind: 'station', channel: 'feishu', originKey: 'pathx.example.com', action: 'upsert',
        payload: { slug: 'px', name: '飞书投稿', description: '飞书描述', url: payloadUrl, rechargeThreshold: null, paymentMethods: [], offers: [] },
        ip: '203.0.113.51', now: new Date('2026-11-06T00:00:00Z'),
      }, { globalPendingBreaker: false }).submission.id;
      reviewSubmission(openStore(server.db), new Date('2026-11-06T00:00:00Z'), id, { status: 'approved' });
    };
    send('https://pathx.example.com/b');

    const rows = read();
    // 两条 url 仍然各自不同，没有变成同一个
    expect(rows.map(row => row.url).sort()).toEqual(['https://pathx.example.com/a', 'https://pathx.example.com/b']);
    // 命中的是整条地址相同的那条
    expect(rows.find(row => row.id === 'agent-path-b.example.com')).toMatchObject({ url: 'https://pathx.example.com/b', name: '飞书投稿' });
    expect(rows.find(row => row.id === 'agent-path-a.example.com')).toMatchObject({ url: 'https://pathx.example.com/a', name: 'agent-path-a.example.com' });
  });

  it('同组里在线的是 www 写法、下架的是另一条同 hostname 重复实体时，认领在线的', async () => {
    // 第 3/4 级（在线分组 vs 下架分组）只有「同 hostname 的重复实体」才区分得开：
    // 已下架那条 rowid 更小时，按 rowid 取第一条会复活它，而在线那条才是现在给人看的。
    const seed = (slug: string, url: string, removed: boolean) => {
      server.db.prepare("INSERT INTO entities (kind, id, data) VALUES ('station', ?, ?)")
        .run(slug, JSON.stringify({ slug, name: slug, description: '描述', url, rechargeThreshold: null, paymentMethods: [], offers: [], status: null, uptime: null, firstTokenLatencyMs: null, foundedAt: null, source: 'agent' }));
      if (removed) server.db.prepare("UPDATE entities SET removedAt = '2026-11-05T00:00:00Z' WHERE kind = 'station' AND id = ?").run(slug);
    };
    // 两条同 hostname（只能在脏数据里出现），已下架的 rowid 更小
    seed('agent-first-removed.example.com', 'https://www.dupg.example.com/', true);
    seed('agent-second-online.example.com', 'https://www.dupg.example.com/', false);
    const read = (slug: string) => server.db.prepare(
      "SELECT json_extract(data,'$.name') name, removedAt FROM entities WHERE kind = 'station' AND id = ?",
    ).get(slug) as { name: string; removedAt: string | null };

    const id = enqueueSubmission(openStore(server.db), {
      kind: 'station', channel: 'feishu', originKey: 'dupg.example.com', action: 'upsert',
      payload: { slug: 'dg', name: '飞书投稿', description: '飞书描述', url: 'https://dupg.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [] },
      ip: '203.0.113.52', now: new Date('2026-11-06T00:00:00Z'),
    }, { globalPendingBreaker: false }).submission.id;
    reviewSubmission(openStore(server.db), new Date('2026-11-06T00:00:00Z'), id, { status: 'approved' });

    expect(read('agent-second-online.example.com')).toMatchObject({ name: '飞书投稿', removedAt: null });
    expect(read('agent-first-removed.example.com')).toMatchObject({ name: 'agent-first-removed.example.com', removedAt: '2026-11-05T00:00:00Z' });
  });

  it('同一个 Store 里先建过索引、再下架站点，下次同步不会把下架那条复活', async () => {
    // 站点认领走「按 Store 版本号 + 内容指纹」缓存的索引。下架一个站**不改它的
    // id 和 url**，所以指纹里必须带 removedAt，否则指纹不变 → 整份沿用旧的在线表
    // → 已下架那条仍在 byHost 里 → 下一次同步把它复活，同一站出现两条在线同 url。
    //
    // 这条用例必须复用**同一个 Store**：其它用例都用 `openStore(server.db)` 造新
    // Store，缓存是冷的，根本走不到这条路径（把 removedAt 从指纹里删掉也全绿）。
    const store = openStore(server.db);
    const seed = (slug: string) => store.put('station', slug, {
      slug, name: slug, description: '描述', url: 'https://cache.example.com/',
      rechargeThreshold: null, paymentMethods: [], status: null,
      uptime: null, firstTokenLatencyMs: null, foundedAt: null, source: 'agent',
    });
    seed('agent-cache-a.example.com');
    seed('agent-cache-b.example.com');
    const sync = (batchId: string) => {
      const id = enqueueSubmission(store, {
        kind: 'station', channel: 'feishu', originKey: 'cache.example.com', batchId, action: 'upsert',
        payload: { slug: 'cache', name: '飞书投稿', description: '飞书描述', url: 'https://cache.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [] },
        ip: '203.0.113.53', now: new Date('2026-11-06T00:00:00Z'),
      }, { globalPendingBreaker: false }).submission.id;
      reviewSubmission(store, new Date('2026-11-06T00:00:00Z'), id, { status: 'approved' });
    };
    sync('cache-b1');   // 首次同步：建缓存，并把 agent-cache-b 更新成投稿内容
    const online = server.db.prepare(
      "SELECT id FROM entities WHERE kind = 'station' AND id LIKE 'agent-cache-%' AND removedAt IS NULL ORDER BY rowid LIMIT 1",
    ).get() as { id: string };
    const latest = server.db.prepare(
      "SELECT id FROM submissions WHERE kind = 'station' AND action = 'upsert' AND status = 'approved' ORDER BY reviewedAt DESC, rowid DESC LIMIT 1",
    ).get() as { id: string };
    expect(removeStation(store, online.id, latest.id, '2026-11-07T00:00:00Z')).toBe(online.id);

    sync('cache-b2');   // 再同步：不能把刚下架那条复活
    const rows = server.db.prepare(
      "SELECT id, removedAt FROM entities WHERE kind = 'station' AND id LIKE 'agent-cache-%' ORDER BY rowid",
    ).all() as { id: string; removedAt: string | null }[];
    expect(rows.filter(row => row.removedAt === null)).toHaveLength(1);
    expect(rows.find(row => row.id === online.id)?.removedAt).toBe('2026-11-07T00:00:00Z');
    // 上面两条断言还挡不住「认领整体失效、每次同步都新建一条站」：
    // 新站叫 sub-cache-*，不在 agent-cache-% 的过滤里，前两条照样绿。
    // 必须断言同步确实更新了仍在线那条，并且没有多建站。
    const survivor = rows.find(row => row.id !== online.id)!;
    expect(server.db.prepare("SELECT json_extract(data,'$.name') name FROM entities WHERE kind = 'station' AND id = ?").get(survivor.id)).toEqual({ name: '飞书投稿' });
    expect(server.db.prepare("SELECT count(*) count FROM entities WHERE kind = 'station' AND id LIKE 'sub-cache-%'").get()).toEqual({ count: 0 });
  });

  it('站点原地换了地址（同一 slug）后，按新地址同步仍认回同一条，不新建', async () => {
    // 指纹只按 id 算会漏掉「id 和 removedAt 都没变、url 变了」这种更新。
    // 运营改站点地址（管理端或导入按 slug 直接写）正是这样：slug 不变，url 换掉。
    // 指纹不含 url 时索引不会重建，新地址在缓存里查不到，同步就会再建一条站。
    const store = openStore(server.db);
    const record = (url: string) => ({
      slug: 'agent-moved.example.com', name: '迁移站', description: '描述', url,
      rechargeThreshold: null, paymentMethods: [], status: null,
      uptime: null, firstTokenLatencyMs: null, foundedAt: null, source: 'agent' as const,
    });
    store.put('station', 'agent-moved.example.com', record('https://moved-old.example.com/'));
    const send = (url: string, batchId: string) => {
      const id = enqueueSubmission(store, {
        kind: 'station', channel: 'feishu', originKey: new URL(url).hostname, batchId, action: 'upsert',
        payload: { slug: 'mv', name: '迁移站', description: '描述', url, rechargeThreshold: null, paymentMethods: [], offers: [] },
        ip: '203.0.113.54', now: new Date('2026-11-06T00:00:00Z'),
      }, { globalPendingBreaker: false }).submission.id;
      reviewSubmission(store, new Date('2026-11-06T00:00:00Z'), id, { status: 'approved' });
    };
    send('https://moved-old.example.com/', 'mv-b1');   // 建索引
    // 原地换地址：slug 与 id 不变
    store.put('station', 'agent-moved.example.com', record('https://moved-new.example.com/'));

    send('https://moved-new.example.com/', 'mv-b2');   // 按新地址同步
    const rows = server.db.prepare(
      "SELECT id, json_extract(data,'$.url') url FROM entities WHERE kind = 'station' AND json_extract(data,'$.url') LIKE 'https://moved-%' ORDER BY rowid",
    ).all() as { id: string; url: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'agent-moved.example.com', url: 'https://moved-new.example.com/' });
  });

  it('在线 /a 与已下架 /b 并存时，按 /b 同步认回已下架那条，不改写 /a 的地址', async () => {
    // 第 2 级「下架整条地址」原来零覆盖：去掉它，75 条用例全绿，但行为确实变坏——
    // 会退到第 3 级按 hostname 认领在线的 /a，把它的 url 改写成 /b，而已下架的 /b
    // 不复活。此后对 /b 调用恢复接口，又是两条在线站同 url。
    const store = openStore(server.db);
    const seed = (slug: string, url: string, removed = false) => {
      store.put('station', slug, {
        slug, name: slug, description: '描述', url, rechargeThreshold: null, paymentMethods: [],
        status: null, uptime: null, firstTokenLatencyMs: null, foundedAt: null, source: 'agent',
      });
      if (removed) store.db.prepare("UPDATE entities SET removedAt = '2026-11-05T00:00:00Z' WHERE kind = 'station' AND id = ?").run(slug);
      store.invalidate();
    };
    seed('agent-path2-a.example.com', 'https://pathy2.example.com/a');
    seed('agent-path2-b.example.com', 'https://pathy2.example.com/b', true);
    const read = (slug: string) => server.db.prepare(
      "SELECT json_extract(data,'$.url') url, json_extract(data,'$.name') name, removedAt FROM entities WHERE kind = 'station' AND id = ?",
    ).get(slug) as { url: string; name: string; removedAt: string | null };

    const id = enqueueSubmission(store, {
      kind: 'station', channel: 'feishu', originKey: 'pathy2.example.com', action: 'upsert',
      payload: { slug: 'py2', name: '飞书投稿', description: '飞书描述', url: 'https://pathy2.example.com/b', rechargeThreshold: null, paymentMethods: [], offers: [] },
      ip: '203.0.113.55', now: new Date('2026-11-06T00:00:00Z'),
    }, { globalPendingBreaker: false }).submission.id;
    reviewSubmission(store, new Date('2026-11-06T00:00:00Z'), id, { status: 'approved' });

    expect(read('agent-path2-b.example.com')).toMatchObject({ url: 'https://pathy2.example.com/b', name: '飞书投稿', removedAt: null });
    expect(read('agent-path2-a.example.com')).toMatchObject({ url: 'https://pathy2.example.com/a', name: 'agent-path2-a.example.com', removedAt: null });
  });

  it('普通写法与 FQDN 尾点写法是同一条站，且都进下架计划', async () => {
    // `https://dot.example.com/` 与 `https://dot.example.com./` 是同一站（FQDN 合法形式）。
    // 之前 shared 的 feishuHostnameKey 去尾点，但服务端 hostnameOf 不去，
    // 于是两条写法落成两个实体；尾点那条既不在飞书下架计划里、人工下架也报
    // STALE_REMOVAL（版本核对不上）。三处归一必须一致：只加这一条用例挡不住。
    const store = openStore(server.db);
    const queue = (host: string, url: string, batch: string) => enqueueSubmission(store, {
      kind: 'station', channel: 'feishu', originKey: host, batchId: batch, action: 'upsert',
      payload: { slug: 'dot', name: '尾点站', description: '描述', url, rechargeThreshold: null, paymentMethods: [], offers: [] },
      ip: '203.0.113.56', now: new Date('2026-11-06T00:00:00Z'),
    }, { globalPendingBreaker: false }).submission.id;
    reviewSubmission(store, new Date('2026-11-06T00:00:00Z'), queue('dot.example.com', 'https://dot.example.com/', 'dot-a'), { status: 'approved' });
    reviewSubmission(store, new Date('2026-11-06T00:00:00Z'), queue('dot.example.com.', 'https://dot.example.com./', 'dot-b'), { status: 'approved' });

    const rows = server.db.prepare(
      "SELECT id, json_extract(data,'$.url') url FROM entities WHERE kind = 'station' AND id LIKE '%dot-example-com%' ORDER BY rowid",
    ).all() as { id: string; url: string }[];
    expect(rows).toHaveLength(1);
    expect(submissionState(store).stations.map(station => station.slug)).toContain(rows[0]!.id);
  });

  it('批准同 hostname 另一条路径的更新，不替代「复活其它路径站」的待审', async () => {
    // supersedePending 旧逻辑首条按 originKey 一刀切：originKey 只是 hostname，
    // 同 hostname 不同路径是两条不同实体。批准 /a 的更新会把「复活 /b」的待审
    // 清成 superseded——那条投稿凭空消失，已下架的站再也救不回来。
    const store = openStore(server.db);
    const seed = (slug: string, url: string) => store.put('station', slug, {
      slug, name: slug, description: '描述', url, rechargeThreshold: null, paymentMethods: [],
      status: null, uptime: null, firstTokenLatencyMs: null, foundedAt: null, source: 'submission' as const,
    });
    seed('sub-sup-a', 'https://sup.example.com/a');
    seed('sub-sup-b', 'https://sup.example.com/b');
    const queue = (batch: string, url: string, name: string) => enqueueSubmission(store, {
      kind: 'station', channel: 'feishu', originKey: 'sup.example.com', batchId: batch, action: 'upsert',
      payload: { slug: 'sup', name, description: '描述', url, rechargeThreshold: null, paymentMethods: [], offers: [] },
      ip: '203.0.113.57', now: new Date('2026-11-06T00:00:00Z'),
    }, { globalPendingBreaker: false }).submission.id;
    // 先给 /b 一个 approved 版本，拿它的 id 下架 /b（模拟正常同步顺序）
    const main = queue('sup-main', 'https://sup.example.com/b', 'B 主版本');
    reviewSubmission(store, new Date('2026-11-06T00:00:00Z'), main, { status: 'approved' });
    const latest = server.db.prepare("SELECT id FROM submissions WHERE kind='station' AND status='approved' ORDER BY reviewedAt DESC, rowid DESC LIMIT 1").get() as { id: string };
    const rem = enqueueSubmission(store, {
      kind: 'station', channel: 'feishu', originKey: 'sup.example.com', batchId: 'sup-rem', action: 'remove',
      payload: { slug: 'sub-sup-b', submissionId: latest.id }, ip: '203.0.113.57', now: new Date('2026-11-07T00:00:00Z'),
    }, { globalPendingBreaker: false }).submission.id;
    reviewSubmission(store, new Date('2026-11-07T00:00:00Z'), rem, { status: 'approved' });
    expect(store.getWithRemoved('station', 'sub-sup-b')?.name).toBe('B 主版本');

    const a2 = queue('sup-a2', 'https://sup.example.com/a', 'A v2');
    const bRevive = queue('sup-b2', 'https://sup.example.com/b', 'B 复活');
    reviewSubmission(store, new Date('2026-11-08T00:00:00Z'), a2, { status: 'approved' });

    const status = (id: string) => (server.db.prepare('SELECT status FROM submissions WHERE id = ?').get(id) as { status: string }).status;
    expect(status(a2)).toBe('approved');
    // 这条绝不能被「另一条路径的更新」顺手替代掉
    expect(status(bRevive)).toBe('pending');
    expect(store.getWithRemoved('station', 'sub-sup-a')?.name).toBe('A v2');
  });

  it('文章关联站点时，尾点与大小写写法归一到同一个站', async () => {
    // 文章与站点的关联只看 hostname。两边写法不一致（站点用尾点、文章不带，或反过来）
    // 会让文章卡片缺站名。两边都必须过同一套归一。
    const store = openStore(server.db);
    store.put('station', 'sub-dotlink-example-com', {
      slug: 'sub-dotlink-example-com', name: '尾点站', description: '描述', url: 'https://DotLink.example.com./',
      rechargeThreshold: null, paymentMethods: [], status: null, uptime: null,
      firstTokenLatencyMs: null, foundedAt: null, source: 'submission' as const,
    });
    const id = enqueueSubmission(store, {
      kind: 'post', channel: 'feishu', originKey: 'recDotLink', batchId: 'dotlink-b1', action: 'upsert',
      payload: { recordId: 'recDotLink', title: '尾点文章', summary: '摘要', body: '正文', authorName: '甲', publishedAt: '2026-11-04T08:00:00.000Z', hostname: 'dotlink.example.com' },
      ip: '203.0.113.58', now: new Date('2026-11-06T00:00:00Z'),
    }, { globalPendingBreaker: false }).submission.id;
    reviewSubmission(store, new Date('2026-11-06T00:00:00Z'), id, { status: 'approved' });
    const row = server.db.prepare("SELECT json_extract(data,'$.stationSlug') slug FROM entities WHERE kind = 'post' AND json_extract(data,'$.title') = '尾点文章'").get() as { slug: string | null };
    expect(row.slug).toBe('sub-dotlink-example-com');
  });

  it('库里的地址带尾点、投稿地址不带且路径不同时，也要认回同一条而不是新建', async () => {
    // 这条专门压 `hostnameOf` 的去尾点：Agent 通道不走飞书分组，只剩 hostname 兜底，
    // 少这一层归一就会另建一条站（同 host 两条实体）。
    const store = openStore(server.db);
    store.put('station', 'agent-dotagent.example.com', {
      slug: 'agent-dotagent.example.com', name: '尾点站', description: '描述',
      url: 'https://dotagent.example.com./pricing', rechargeThreshold: null, paymentMethods: [],
      status: null, uptime: null, firstTokenLatencyMs: null, foundedAt: null, source: 'agent' as const,
    });
    const id = enqueueSubmission(store, {
      kind: 'station', channel: 'agent', originKey: 'dotagent.example.com', action: 'upsert',
      payload: { slug: 'dotagent', name: 'Agent 投稿', description: '描述', url: 'https://dotagent.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [] },
      ip: '203.0.113.59', now: new Date('2026-11-06T00:00:00Z'),
    }, { globalPendingBreaker: false }).submission.id;
    reviewSubmission(store, new Date('2026-11-06T00:00:00Z'), id, { status: 'approved' });

    const rows = server.db.prepare(
      "SELECT id, json_extract(data,'$.url') url, json_extract(data,'$.name') name FROM entities WHERE kind = 'station' AND id LIKE '%dotagent%' ORDER BY rowid",
    ).all() as { id: string; url: string; name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'agent-dotagent.example.com', name: 'Agent 投稿' });
  });

  it('在线 /b 与「已下架且地址带尾点」的 /a 并存时，投 /a 要复活 /a、不改写 /b', async () => {
    // 这条专门压 `stationUrlKey` 的去尾点：两条路径不同，hostname 兜底会认错实体，
    // 把在线 /b 的地址改写成 /a，而已下架的 /a 反而不复活。
    const store = openStore(server.db);
    const seed = (slug: string, url: string, removed = false) => {
      store.put('station', slug, {
        slug, name: slug, description: '描述', url, rechargeThreshold: null, paymentMethods: [],
        status: null, uptime: null, firstTokenLatencyMs: null, foundedAt: null, source: 'submission' as const,
      });
      if (removed) server.db.prepare("UPDATE entities SET removedAt = '2026-11-01T00:00:00Z' WHERE kind = 'station' AND id = ?").run(slug);
      store.invalidate();
    };
    seed('agent-dotpath-a.example.com', 'https://dotpath.example.com./a', true);
    seed('agent-dotpath-b.example.com', 'https://dotpath.example.com/b');
    const id = enqueueSubmission(store, {
      kind: 'station', channel: 'feishu', originKey: 'dotpath.example.com', action: 'upsert',
      payload: { slug: 'dotpath', name: 'A 复活', description: '描述', url: 'https://dotpath.example.com/a', rechargeThreshold: null, paymentMethods: [], offers: [] },
      ip: '203.0.113.60', now: new Date('2026-11-06T00:00:00Z'),
    }, { globalPendingBreaker: false }).submission.id;
    reviewSubmission(store, new Date('2026-11-06T00:00:00Z'), id, { status: 'approved' });

    const read = (slug: string) => server.db.prepare(
      "SELECT json_extract(data,'$.url') url, json_extract(data,'$.name') name, removedAt FROM entities WHERE kind = 'station' AND id = ?",
    ).get(slug) as { url: string; name: string; removedAt: string | null };
    expect(read('agent-dotpath-a.example.com')).toMatchObject({ name: 'A 复活', removedAt: null });
    expect(read('agent-dotpath-b.example.com')).toMatchObject({ url: 'https://dotpath.example.com/b', name: 'agent-dotpath-b.example.com' });
  });

  it('站内作者自己的文章也能被管理员下架，不必走投稿队列', async () => {
    // source='user' 的文章原本只能改状态：前台确实看不见了，但管理端既没有
    // 恢复入口，也查不到下架时间。统一走软删除后两者都有了。
    const cookie = await register('authorone');
    const created = await (await post('/api/posts', { kind: 'review', title: '我的评测', summary: 's', body: 'b' }, '203.0.113.9', cookie)).json() as { id: string };
    // 走真实审核把它物化，而不是手工 put：只手工写实体的话投稿行还是 pending，
    // readablePost 会从队列里把它兜回来，下架后作者仍看得到——那是另一条路径的问题。
    reviewSubmission(openStore(server.db), clock, created.id, { status: 'approved' });
    expect((await server.app.request(`/api/posts/${created.id}`, { headers: { cookie } })).status).toBe(200);
    expect((await server.app.request(`/api/admin/posts/${created.id}/withdraw`, { method: 'POST', headers: admin })).status).toBe(200);
    expect((await server.app.request(`/api/posts/${created.id}`, { headers: { cookie } })).status).toBe(404);
    // 作者自己也看不到了：下架就是下架，不是「只对别人隐藏」。
    // 只断言 200 是不够的——列表接口当然可能返回 200 而里面仍然列着这篇，
    // 那正是要防的回归。这里断言列表内容为空。
    const mine = await server.app.request('/api/me/posts', { headers: { cookie } });
    expect(mine.status).toBe(200);
    const listed = await mine.json() as { items: { id: string }[]; total: number };
    expect(listed.items.map(item => item.id)).not.toContain(created.id);
    expect(listed.total).toBe(0);
  });
});

describe('改密码', () => {
  const change = (currentPassword: string, newPassword: string, cookie: string) => post('/api/auth/password', { currentPassword, newPassword }, '203.0.113.1', cookie);
  const me = (cookie: string) => server.app.request('/api/me', { headers: { cookie } });

  it('未登录 401', async () => {
    expect((await post('/api/auth/password', { currentPassword: PASSWORD, newPassword: NEXT_PASSWORD })).status).toBe(401);
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

describe('签到限流', () => {
  it('连续签到超限后返回 429，冷却后恢复', async () => {
    // 签到一天只能成功一次，但每次调用都要走事务和写库。
    // 没有闸门时脚本可以循环打点压库，这里补上 5 次/小时的限制。
    await register('alice');
    const session = await login('alice', PASSWORD);
    const cookie = session.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    for (let index = 0; index < 5; index++) {
      const response = await server.app.request('/api/me/checkin', { method: 'POST', headers: { cookie, 'content-type': 'application/json' } });
      expect(response.status).toBeLessThan(500);
    }
    const blocked = await server.app.request('/api/me/checkin', { method: 'POST', headers: { cookie, 'content-type': 'application/json' } });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: { code: 'RATE_LIMITED', retryAfter: expect.any(Number) } });
  });
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
describe('管理员重置密码', () => {
  const resetAdmin = (body: unknown, auth = TOKEN) =>
    server.app.request('/api/admin/accounts/reset-password', {
      method: 'POST', headers: { ...json, authorization: `Bearer ${auth}` }, body: JSON.stringify(body),
    }, proxied);

  it('重置后旧密码失效、新密码可用，会话与 Agent 凭证全部吊销', async () => {
    const cookie = await register('forgetful');
    // 签发 Agent 凭证要求注册满 7 天（或已有通过投稿/邀请码），把时钟推过去。
    clock = new Date(clock.getTime() + 8 * 24 * 60 * 60_000);
    const created = await server.app.request('/api/account/agent-tokens', {
      method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ label: 'cli' }),
    }, proxied);
    expect(created.status).toBe(200);
    const { token } = await created.json() as { token: string };

    const reset = await resetAdmin({ username: 'forgetful', newPassword: NEXT_PASSWORD });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ ok: true, handle: 'forgetful' });

    // 旧会话失效
    const me = await server.app.request('/api/me', { headers: { cookie } }, proxied);
    expect(me.status).toBe(401);
    // Agent 凭证失效
    const submit = await server.app.request('/api/agent/stations', {
      method: 'POST', headers: { ...json, authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: 'station', action: 'upsert', payload: {} }),
    }, proxied);
    expect(submit.status).toBe(401);
    // 旧密码登录失败，新密码成功
    expect((await login('forgetful', PASSWORD)).status).toBe(401);
    expect((await login('forgetful', NEXT_PASSWORD, '198.51.100.9')).status).toBe(200);
  }, 60_000);

  it('管理员设的弱密码同样被拒', async () => {
    await register('weakadmin');
    const reset = await resetAdmin({ username: 'weakadmin', newPassword: 'welcome123' });
    expect(reset.status).toBe(400);
    expect(await reset.json()).toMatchObject({ error: { code: 'WEAK_PASSWORD' } });
  });

  it('用户名不存在时 404', async () => {
    const reset = await resetAdmin({ username: 'nobody_here', newPassword: NEXT_PASSWORD });
    expect(reset.status).toBe(404);
  });

  it('没有管理密钥时拒绝', async () => {
    await register('target_user');
    // 与其它管理接口一致：密钥不对是 403，不是 404——404 留给「用户名不存在」。
    const reset = await resetAdmin({ username: 'target_user', newPassword: NEXT_PASSWORD }, 'wrong-token');
    expect(reset.status).toBe(403);
  });
});

describe('仓库卫生', () => {
  it('测试里不出现 username/password 相邻字面量（GitGuardian 会判成硬编码凭据）', () => {
    // 这类误报已经来过三次（ff32468 / dbb5ffd / 我加「推荐新站」测试那次）。
    // 每次都是「拿一个本意无害的测试口令，但把两个键写成同一行里相邻的两个字面量」。
    // 约定是提到常量（见本文件顶部 PASSWORD），这里把它钉死：
    // 以后谁再这么写，这条测试直接红，不用等邮件通知。
    //
    // 注意这条注释本身也不能把那个形态原样写出来——GitGuardian 扫的是文本，
    // 它分不清这是注释还是代码。3492e8b 的两个 incident 里就有一个是旧注释。
    // 必须连 src 一起扫。3492e8b 的两个 incident 里，一个在 web/src/pages/Auth.tsx
    // （注册表单的空初始值，值全是空串），只扫测试目录是盖不住的——扫描器不区分
    // 「这是表单默认值」还是「这是真凭据」，它只认两个键相邻这个形态。
    // scripts 没有 src 子目录，源码直接在包根下。
    const roots = ['server/src', 'server/test', 'web/src', 'web/test', 'shared/src', 'shared/test', 'scripts', 'scripts/test'];
    const seen = new Set<string>();
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { walk(path); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        // 跳过本测试自己：它的正则源码里就含 `password: '` 这样的字面量，
        // 不排除的话会自己报自己。
        if (path.endsWith('hardening.test.ts')) continue;
        // scripts 与 scripts/test 有包含关系，同一文件别报两次。
        if (seen.has(path)) continue;
        seen.add(path);
        for (const [index, line] of readFileSync(path, 'utf8').split('\n').entries()) {
          // 只看同一行里 username 与 password（或 currentPassword/newPassword）都跟了字面量
          const pair = /username:\s*'[^']*'[\s\S]{0,80}?password:\s*'[^']*'|password:\s*'[^']*'[\s\S]{0,80}?username:\s*'[^']*'/;
          // 常量不算：password: PASSWORD 没有引号，不会命中
          if (pair.test(line)) offenders.push(`${path}:${index + 1}`);
        }
      }
    };
    for (const root of roots) walk(join(process.cwd(), '..', root));
    expect(offenders).toEqual([]);
    // 要遍历四个目录的全部源码，机器一忙就超过默认 5s。这是一次性扫描，
    // 放长超时不会掩盖问题——真的出现字面量，断言照样会红。
  }, 60_000);
});
