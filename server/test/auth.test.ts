import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CurrentUser, Post, StationDetail } from '@zhidedeng/shared';
import { createApp } from '../src/node-app.ts';

const json = { 'content-type': 'application/json' };
const PASSWORD = 'correct-horse-battery';

let clock: Date;
let server: ReturnType<typeof createApp>;
beforeEach(() => {
  clock = new Date('2026-11-06T01:00:00Z');
  server = createApp({ dbPath: ':memory:', now: () => clock });
});
afterEach(() => server.db.close());

const count = (sql: string) => Number((server.db.prepare(sql).get() as { count: number }).count);

/** 像浏览器一样保存 cookie。 */
function browser(ip = '203.0.113.1') {
  let cookie = '';
  const env = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
  async function call(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { 'x-forwarded-for': ip };
    if (cookie) headers.cookie = cookie;
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const response = await server.app.request(path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) }, env);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0].endsWith('=') ? '' : setCookie.split(';')[0];
    return response;
  }
  return {
    call,
    cookie: () => cookie,
    setCookie: (value: string) => { cookie = value; },
    register: (username: string, extra: object = {}) => call('POST', '/api/auth/register', { username, password: PASSWORD, ...extra }),
    login: (username: string, password = PASSWORD) => call('POST', '/api/auth/login', { username, password }),
    get: async <T,>(path: string) => await (await call('GET', path)).json() as T,
  };
}

describe('注册', () => {
  it('注册后即登录，cookie 属性正确，初始 Token 120，昵称可中文', async () => {
    const a = browser();
    const response = await a.register('alice_1', { nickname: '爱丽丝' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ handle: 'alice_1', nickname: '爱丽丝', tokens: 120, checkedInToday: false, shareCount: 0 });
    expect(response.headers.get('set-cookie')).toMatch(/^session=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/);
    expect(await a.get<CurrentUser>('/api/me')).toMatchObject({ handle: 'alice_1' });
  });

  it('未填昵称时用用户名', async () => {
    expect(await (await browser().register('bob')).json()).toMatchObject({ nickname: 'bob' });
  });

  it('库里只存 token 的摘要和密码的加盐哈希', async () => {
    const a = browser();
    await a.register('alice');
    const token = a.cookie().split('=')[1];
    const dump = JSON.stringify([server.db.prepare('SELECT * FROM sessions').all(), server.db.prepare('SELECT * FROM accounts').all()]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).toMatch(/"tokenHash":"[0-9a-f]{64}"/);
    expect(dump).toMatch(/"passwordHash":"scrypt\$/);
  });

  it('相同密码的盐不同，哈希不同', async () => {
    await browser().register('alice');
    await browser().register('bobby');
    const hashes = server.db.prepare('SELECT passwordHash FROM accounts').all() as { passwordHash: string }[];
    expect(hashes[0].passwordHash).not.toBe(hashes[1].passwordHash);
  });

  it('用户名大小写不敏感唯一', async () => {
    await browser().register('Alice');
    const again = await browser().register('aLICE');
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'USERNAME_TAKEN' } });
    expect(count('SELECT count(*) AS count FROM accounts')).toBe(1);
  });

  it.each([
    ['用户名太短', { username: 'ab', password: PASSWORD }],
    ['用户名太长', { username: 'a'.repeat(21), password: PASSWORD }],
    ['用户名含连字符（防撞种子用户）', { username: 'demo-pedal', password: PASSWORD }],
    ['用户名含中文', { username: '爱丽丝', password: PASSWORD }],
    ['密码不足 8 位', { username: 'alice', password: '1234567' }],
    ['多余字段', { username: 'alice', password: PASSWORD, tokens: 999 }],
  ])('拒绝%s', async (_name, body) => {
    const response = await browser().call('POST', '/api/auth/register', body);
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(count('SELECT count(*) AS count FROM accounts')).toBe(0);
  });

  it('同一 IP 注册过多返回 429', async () => {
    const a = browser();
    for (let index = 0; index < 10; index++) await browser().call('POST', '/api/auth/register', { username: 'taken', password: PASSWORD });
    const limited = await a.register('newcomer');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    clock = new Date(clock.getTime() + 3601_000);
    expect((await a.register('newcomer')).status).toBe(200);
  }, 30_000);
});

describe('登录与登出', () => {
  it('登录成功，用户名大小写不敏感', async () => {
    await browser().register('Alice');
    const a = browser();
    const response = await a.login('aLiCe');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ handle: 'Alice' });
    expect((await a.call('GET', '/api/me')).status).toBe(200);
  });

  it('错误密码和不存在的用户名错误完全相同，不下发 cookie', async () => {
    await browser().register('alice');
    const wrong = await browser().login('alice', 'wrong-password');
    const missing = await browser().login('nobody', 'wrong-password');
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    expect(await wrong.json()).toEqual(await missing.json());
  });

  it('种子里的虚构用户没有密码，不能登录', async () => {
    expect((await browser().login('demo-pedal', 'anything-at-all')).status).toBe(401);
  });

  it('登出后会话失效，旧 cookie 再用也不行，其他会话不受影响', async () => {
    const a = browser();
    await a.register('alice');
    const stolen = a.cookie();
    const other = browser();
    await other.login('alice');
    const out = await a.call('POST', '/api/auth/logout');
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(/^session=; Max-Age=0;/);
    expect((await a.call('GET', '/api/me')).status).toBe(401);
    a.setCookie(stolen);
    expect((await a.call('GET', '/api/me')).status).toBe(401);
    expect((await other.call('GET', '/api/me')).status).toBe(200);
  });

  it('未登录时登出也幂等成功', async () => {
    expect((await browser().call('POST', '/api/auth/logout')).status).toBe(200);
  });

  it('会话 30 天后过期', async () => {
    const a = browser();
    await a.register('alice');
    clock = new Date(clock.getTime() + 30 * 86400000 - 1000);
    expect((await a.call('GET', '/api/me')).status).toBe(200);
    clock = new Date(clock.getTime() + 2000);
    expect((await a.call('GET', '/api/me')).status).toBe(401);
  });

  it('伪造或格式错误的 cookie 视为未登录', async () => {
    const a = browser();
    a.setCookie(`session=${'a'.repeat(43)}`);
    expect((await a.call('GET', '/api/me')).status).toBe(401);
    a.setCookie("session=' OR 1=1 --");
    expect((await a.call('GET', '/api/me')).status).toBe(401);
  });

  it('同 IP + 用户名失败 5 次后临时拒绝，正确密码也不行；窗口过后恢复，换 IP 不受影响', async () => {
    await browser().register('alice');
    const a = browser('203.0.113.9');
    for (let index = 0; index < 5; index++) expect((await a.login('alice', 'wrong-password')).status).toBe(401);
    const limited = await a.login('alice');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect((await browser('203.0.113.10').login('alice')).status).toBe(200);
    clock = new Date(clock.getTime() + 15 * 60_000 + 1000);
    expect((await a.login('alice')).status).toBe(200);
  }, 30_000);

  it('同 IP 换用户名撞库，累计 30 次后也被拒', async () => {
    const a = browser('203.0.113.20');
    for (let index = 0; index < 30; index++) await a.login(`user${index}`, 'wrong-password');
    expect((await a.login('user99', 'wrong-password')).status).toBe(429);
  }, 60_000);

  it('只信任本机反代的 X-Forwarded-For：直连方不是本机时用真实地址', async () => {
    await browser().register('alice');
    const env = { incoming: { socket: { remoteAddress: '198.51.100.7' } } };
    const attempt = (forged: string) => server.app.request('/api/auth/login', { method: 'POST', headers: { ...json, 'x-forwarded-for': forged }, body: JSON.stringify({ username: 'alice', password: 'wrong-password' }) }, env);
    for (let index = 0; index < 5; index++) await attempt(`10.0.0.${index}`);
    expect((await attempt('10.0.0.99')).status).toBe(429);
  }, 30_000);
});

describe('未登录只读', () => {
  it.each([
    ['GET', '/api/me'],
    ['GET', '/api/me/favorites'],
    ['GET', '/api/me/posts'],
    ['PATCH', '/api/me'],
    ['POST', '/api/me/checkin'],
    ['POST', '/api/posts'],
    ['PUT', '/api/votes'],
    ['PUT', '/api/favorites'],
    ['POST', '/api/comments'],
  ])('%s %s 返回 401 UNAUTHENTICATED，不写库', async (method, path) => {
    const before = count('SELECT count(*) AS count FROM entities') + count('SELECT count(*) AS count FROM votes');
    const response = await browser().call(method, path, { targetType: 'post', targetId: 'post-1', value: 'up' });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(count('SELECT count(*) AS count FROM entities') + count('SELECT count(*) AS count FROM votes')).toBe(before);
  });

  it('公开内容不用登录，currentUserVote 为 null', async () => {
    const a = browser();
    expect((await a.call('GET', '/api/posts')).status).toBe(200);
    expect(await a.get<Post>('/api/posts/post-2')).toMatchObject({ currentUserVote: null, favorited: false });
    expect(a.cookie()).toBe('');
  });

  it('种子账号的收藏不算在任何访客头上', async () => {
    const station = await browser().get<StationDetail>('/api/stations/whale-demo');
    expect(station.favorited).toBe(false);
  });
});

describe('CSRF', () => {
  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', undefined])('写接口拒绝 Content-Type=%s', async type => {
    const a = browser();
    await a.register('alice');
    const headers: Record<string, string> = { cookie: a.cookie() };
    if (type) headers['content-type'] = type;
    const response = await server.app.request('/api/me/checkin', { method: 'POST', headers, body: '{}' });
    expect(response.status).toBe(415);
    expect(await a.get<CurrentUser>('/api/me')).toMatchObject({ checkedInToday: false });
  });
});

describe('互动按账号存、对所有人累计', () => {
  it('两个账号投票累计，每人一票可改可撤，匿名也看到总数', async () => {
    const [a, b] = [browser(), browser()];
    await a.register('alice');
    await b.register('bobby');
    const anonymous = browser();
    const base = await anonymous.get<StationDetail>('/api/stations/whale-demo');
    const vote = (who: typeof a, value: string | null) => who.call('PUT', '/api/votes', { targetType: 'station', targetId: 'whale-demo', value });
    await vote(a, 'up');
    await vote(a, 'up');
    await vote(b, 'up');
    expect((await anonymous.get<StationDetail>('/api/stations/whale-demo')).votes.up).toBe(base.votes.up + 2);
    expect(await a.get<StationDetail>('/api/stations/whale-demo')).toMatchObject({ currentUserVote: 'up' });
    await vote(b, 'down');
    expect(await anonymous.get<StationDetail>('/api/stations/whale-demo')).toMatchObject({ votes: { up: base.votes.up + 1, down: base.votes.down + 1 }, currentUserVote: null });
    await vote(a, null);
    expect((await b.get<StationDetail>('/api/stations/whale-demo')).votes.up).toBe(base.votes.up);
  });

  it('收藏累计，个人收藏列表和签到各算各的', async () => {
    const [a, b] = [browser(), browser()];
    await a.register('alice');
    await b.register('bobby');
    const base = (await browser().get<StationDetail>('/api/stations/whale-demo')).favoriteCount;
    for (const who of [a, b]) await who.call('PUT', '/api/favorites', { targetType: 'station', targetId: 'whale-demo', favorited: true });
    expect((await browser().get<StationDetail>('/api/stations/whale-demo')).favoriteCount).toBe(base + 2);
    expect(await a.get<CurrentUser>('/api/me')).toMatchObject({ favoriteCount: 1 });

    expect((await a.call('POST', '/api/me/checkin')).status).toBe(200);
    expect(await a.get<CurrentUser>('/api/me')).toMatchObject({ checkedInToday: true, tokens: 131 });
    expect(await b.get<CurrentUser>('/api/me')).toMatchObject({ checkedInToday: false, tokens: 120 });
    expect((await b.call('POST', '/api/me/checkin')).status).toBe(200);
    expect((await a.call('POST', '/api/me/checkin')).status).toBe(409);
  });
});

describe('用户名探测的限流', () => {
  it('同一用户名被反复探测时返回 429，不能无限枚举', async () => {
    // 用户名是否被占用只能从响应推断，所以按用户名维度限流，
    // 让人没法用字典把注册名一个个试出来。
    const a = browser();
    await a.register('taken_name');
    // 每次都换一个来源 IP：否则先撞上的是按 IP 的 10 次上限，
    // 验不到「按用户名」这一维。
    const codes: number[] = [];
    for (let index = 0; index < 22; index += 1) {
      codes.push((await browser(`198.51.100.${index + 1}`).register('taken_name')).status);
    }
    // 首次注册也算一次该用户名的计数，所以前 19 次探测是 409，第 20 次起 429。
    expect(codes.slice(0, 19).every(code => code === 409)).toBe(true);
    expect(codes.slice(19).every(code => code === 429)).toBe(true);
  });
});

describe('注册时的昵称校验', () => {
  it('注册不能直接占用保留身份', async () => {
    // 只挡「改资料」的话，注册时直接填「管理员」就是一条现成的绕过路径。
    const response = await browser().register('nasty_user', { nickname: '管理员' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('注册不能与他人重名', async () => {
    await browser().register('first_user', { nickname: '独一无二' });
    const response = await browser('198.51.100.77').register('second_user', { nickname: '独一无二' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'NICKNAME_TAKEN' } });
  });

  it('正常昵称不受影响，包括含保留词的普通昵称', async () => {
    for (const [index, nickname] of ['系统工程师', '中国女排官方', '官方粉丝'].entries()) {
      const response = await browser(`198.51.100.${100 + index}`).register(`nick_user_${index}`, { nickname });
      expect(response.status).toBe(200);
    }
  });
});
