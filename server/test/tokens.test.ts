import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/node-app.ts';
import type { GetMyTokensResponse, GetTokenLedgerResponse, RedeemTokensResponse } from '@zhidedeng/shared';

const PASSWORD = 'correct-horse-battery';
const json = { 'content-type': 'application/json' };
const TOKEN = 'admin-token-for-tests-0123456789abcdef';
const bearer = { ...json, authorization: `Bearer ${TOKEN}` };

let clock: Date;
let server: ReturnType<typeof createApp>;
beforeEach(() => {
  // 定在月中，避免「昨天是上个月」这类跨月把配额断言搅乱。
  clock = new Date('2026-11-15T04:00:00Z');
  server = createApp({ dbPath: ':memory:', now: () => clock, syncToken: TOKEN });
});
afterEach(() => server.db.close());

async function account(username: string) {
  const response = await server.app.request('/api/auth/register', {
    method: 'POST', headers: json, body: JSON.stringify({ username, password: PASSWORD, nickname: username }),
  });
  expect(response.status).toBe(200);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  return {
    cookie,
    call: (method: string, path: string, body?: unknown) => server.app.request(path, {
      method, headers: { ...json, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    // 每次兑换前把时钟推 61 秒：路由层按账号限流 6 次/分钟，测试里连点会被
    // 限流挡住，而那测的是限流器、不是兑换规则。真实用户也不会在同一秒连兑 20 次。
    redeem: (itemKey: string, targetId?: string, idempotencyKey = `key-${itemKey}-${Math.random().toString(36).slice(2, 10)}`) => {
      clock = new Date(clock.getTime() + 61_000);
      return server.app.request('/api/me/tokens/redeem', {
        method: 'POST', headers: { ...json, cookie },
        body: JSON.stringify({ itemKey, idempotencyKey, ...(targetId ? { targetId } : {}) }),
      });
    },
  };
}
type Caller = Awaited<ReturnType<typeof account>>;

const shop = async (who: Caller) => await (await who.call('GET', '/api/me/tokens')).json() as GetMyTokensResponse;
const ledger = async (who: Caller) => (await (await who.call('GET', '/api/me/tokens/ledger?pageSize=50')).json() as GetTokenLedgerResponse).items;

async function publishedPost(who: Caller, title = '待送花的文章') {
  const created = await who.call('POST', '/api/posts', { kind: 'community', title, summary: 's', body: 'b' });
  const id = (await created.json() as { id: string }).id;
  await server.app.request(`/api/admin/posts/${id}/review`, {
    method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
  });
  return id;
}

describe('Token 账本', () => {
  it('注册赠币进流水，余额等于流水累加', async () => {
    const alice = await account('alice');
    expect((await shop(alice)).balance).toBe(120);
    const entries = await ledger(alice);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ delta: 120, balanceAfter: 120, reason: 'signup' });
  });

  it('签到记一笔流水，余额随之上涨；同一天不会重复入账', async () => {
    const alice = await account('alice');
    const checked = await alice.call('POST', '/api/me/checkin', {});
    expect(checked.status).toBe(200);
    const body = await checked.json() as { tokens: number; tokensAwarded: number };
    expect(body.tokens).toBe(120 + body.tokensAwarded);
    expect((await shop(alice)).balance).toBe(120 + body.tokensAwarded);

    // 重复签到被业务层挡住（409），账本不该多一条。
    expect((await alice.call('POST', '/api/me/checkin', {})).status).toBe(409);
    expect(await ledger(alice)).toHaveLength(2);
    // 签到流水必须带幂等键：这是并发下「同一件事只记一次」的最后一道保险，
    // 只靠「先读 checkedInToday 再写」挡不住两个事务同时进到写之前。
    expect(server.db.prepare("SELECT onceKey FROM token_ledger WHERE handle = 'alice' AND reason = 'checkin'").get())
      .toMatchObject({ onceKey: expect.stringMatching(/^checkin:\d{4}-\d{2}-\d{2}$/) });
  });

  it('送花扣 5，一篇一人一朵，作者收到通知', async () => {
    const alice = await account('alice');
    const bob = await account('bob');
    const id = await publishedPost(bob);

    const sent = await alice.redeem('flower', id);
    expect(sent.status).toBe(200);
    const result = await sent.json() as RedeemTokensResponse;
    expect(result.balance).toBe(115);
    expect(result.order).toMatchObject({ itemKey: 'flower', cost: 5, targetType: 'post', targetId: id });

    // 账本必须对上，而不是只看响应里的余额。
    expect(await ledger(alice)).toContainEqual(expect.objectContaining({ delta: -5, balanceAfter: 115, reason: 'redeem' }));
    expect(server.db.prepare("SELECT count(*) AS c FROM token_ledger WHERE handle = 'alice'").get()).toEqual({ c: 2 });

    // 同一篇再送一次：挡住。只查响应余额的话，这里可能被静默扣第二次。
    const again = await alice.redeem('flower', id);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'ALREADY_TIPPED' } });
    expect((await shop(alice)).balance).toBe(115);

    const notices = await (await bob.call('GET', '/api/me/notifications?pageSize=20')).json() as
      { items: Array<{ title: string }> };
    expect(notices.items.some(item => item.title.includes('花'))).toBe(true);
  });

  it('不能给自己送花，也不能送给没上线的文章', async () => {
    const alice = await account('alice');
    const mine = await publishedPost(alice, '我自己的文章');
    expect((await alice.redeem('flower', mine)).status).toBe(409);

    const draft = await alice.call('POST', '/api/posts', { kind: 'community', title: '还没审的', summary: 's', body: 'b' });
    const draftId = (await draft.json() as { id: string }).id;
    expect((await alice.redeem('flower', draftId)).status).toBe(404);
  });

  it('余额不足时拒绝，且不留下兑换单', async () => {
    const alice = await account('alice');
    const bob = await account('bob');
    const id = await publishedPost(bob);
    const second = await publishedPost(bob, '第二篇');
    // 把余额压到 3：一朵花要 5。
    server.db.prepare("UPDATE token_ledger SET balanceAfter = 3 WHERE handle = 'alice'").run();

    const poor = await alice.redeem('flower', id);
    expect(poor.status).toBe(409);
    expect(await poor.json()).toMatchObject({ error: { code: 'INSUFFICIENT_TOKENS' } });
    // 兑换单不能留下：不然重试会因为「已经送过」被挡，用户永远送不出这朵花。
    expect(server.db.prepare("SELECT count(*) AS c FROM redemptions WHERE handle = 'alice'").get()).toEqual({ c: 0 });
    expect(server.db.prepare("SELECT count(*) AS c FROM token_ledger WHERE handle = 'alice' AND reason = 'redeem'").get()).toEqual({ c: 0 });
    // 补足之后同一篇还能送：证明上面那次失败没有留下任何痕迹。
    server.db.prepare("UPDATE token_ledger SET balanceAfter = 100 WHERE handle = 'alice'").run();
    expect((await alice.redeem('flower', id)).status).toBe(200);
    expect((await alice.redeem('flower', second)).status).toBe(200);
  });

  it('同一个请求编号重放：返回原单，不重复扣费；换个项目才算冲突', async () => {
    const alice = await account('alice');
    const bob = await account('bob');
    const id = await publishedPost(bob);

    const first = await alice.redeem('flower', id, 'stable-key-0001');
    expect(first.status).toBe(200);
    const firstBody = await first.json() as RedeemTokensResponse;

    const replay = await alice.redeem('flower', id, 'stable-key-0001');
    expect(replay.status).toBe(200);
    const replayBody = await replay.json() as RedeemTokensResponse;
    expect(replayBody.order.id).toBe(firstBody.order.id);
    // 只扣了一次。
    expect(replayBody.balance).toBe(firstBody.balance);
    expect(server.db.prepare("SELECT count(*) AS c FROM token_ledger WHERE handle = 'alice' AND reason = 'redeem'").get()).toEqual({ c: 1 });

    const conflict = await alice.redeem('export', undefined, 'stable-key-0001');
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('送花每月最多 20 朵（含不同文章）', async () => {
    const alice = await account('alice');
    const bob = await account('bob');
    // 给足余额，专测配额。
    server.db.prepare("UPDATE token_ledger SET balanceAfter = 5000 WHERE handle = 'alice'").run();
    // 21 篇直接写库：站内投稿限流 10 篇/小时，用接口造就先被投稿限流挡住了，
    // 而这里要测的是「送花每月 20 朵」、不是投稿配额。
    const ids: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const id = `bulk-${index}`;
      server.store.put('post', id, {
        id, kind: 'community', title: `第 ${index} 篇`, summary: 's', body: 'b',
        authorHandle: 'bob', stationSlug: null, modelSlug: null, cover: null,
        publishedAt: clock.toISOString(), status: 'approved', source: 'user',
      });
      ids.push(id);
    }

    for (let index = 0; index < 20; index += 1) {
      expect((await alice.redeem('flower', ids[index])).status).toBe(200);
    }
    const over = await alice.redeem('flower', ids[20]);
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: { code: 'MONTHLY_LIMIT' } });

    // 到下个月额度恢复。
    clock = new Date('2026-12-02T04:00:00Z');
    expect((await alice.redeem('flower', ids[20])).status).toBe(200);
  });

  it('徽章：注册满 3 天才能买，买了只能有一枚，永久有效', async () => {
    const alice = await account('alice');
    server.db.prepare("UPDATE token_ledger SET balanceAfter = 1000 WHERE handle = 'alice'").run();

    const tooEarly = await alice.redeem('badge');
    expect(tooEarly.status).toBe(403);
    expect(await tooEarly.json()).toMatchObject({ error: { code: 'ACCOUNT_TOO_NEW' } });

    clock = new Date(clock.getTime() + 4 * 86_400_000);
    const bought = await alice.redeem('badge');
    expect(bought.status).toBe(200);
    expect((await shop(alice)).entitlements).toEqual(['supporter']);

    // 当月再买：被「每月 1 次」挡住。
    const sameMonth = await alice.redeem('badge');
    expect(sameMonth.status).toBe(429);
    expect(await sameMonth.json()).toMatchObject({ error: { code: 'MONTHLY_LIMIT' } });
    expect((await shop(alice)).usedThisMonth.badge).toBe(1);

    // 跨月之后月配额恢复了，但徽章已经在名下——靠权益表挡住，而不是靠月配额。
    // 两条判据缺一条：只留月配额的话，等一个月就能花 240 买一个不存在的第二枚。
    clock = new Date('2026-12-02T04:00:00Z');
    const nextMonth = await alice.redeem('badge');
    expect(nextMonth.status).toBe(409);
    expect(await nextMonth.json()).toMatchObject({ error: { code: 'ALREADY_OWNED' } });
  });

  it('导出：只含自己的内容，每月 2 次', async () => {
    const alice = await account('alice');
    server.db.prepare("UPDATE token_ledger SET balanceAfter = 1000 WHERE handle = 'alice'").run();
    const mine = await publishedPost(alice, '我的导出文章');
    await alice.call('POST', '/api/comments', { targetType: 'post', targetId: mine, content: '我的评论' });
    // 别人的评论不该出现。
    const bob = await account('bob');
    await bob.call('POST', '/api/comments', { targetType: 'post', targetId: mine, content: '别人的评论' });

    const exported = await alice.redeem('export');
    expect(exported.status).toBe(200);
    const body = await exported.json() as RedeemTokensResponse;
    const payload = body.order.payload as { posts: Array<{ title: string }>; comments: Array<{ content: string }> };
    expect(payload.posts.map(post => post.title)).toContain('我的导出文章');
    expect(payload.comments.map(comment => comment.content)).toEqual(['我的评论']);

    expect((await alice.redeem('export')).status).toBe(200);
    const third = await alice.redeem('export');
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: { code: 'MONTHLY_LIMIT' } });
  });

  it('补签卡：只补昨天、只补真漏的、不补 Token、接不上连续就拒绝', async () => {
    const alice = await account('alice');
    server.db.prepare("UPDATE token_ledger SET balanceAfter = 1000 WHERE handle = 'alice'").run();

    // 前天签了、昨天漏了 → 可以补。
    const twoDaysAgo = '2026-11-13';
    server.db.prepare('INSERT INTO checkins (userHandle,date,tokensAwarded,streak) VALUES (?,?,?,?)').run('alice', twoDaysAgo, 13, 3);
    const before = (await shop(alice)).balance;
    const filled = await alice.redeem('makeup', '2026-11-14');
    expect(filled.status).toBe(200);
    const day = server.db.prepare("SELECT tokensAwarded, streak FROM checkins WHERE userHandle = 'alice' AND date = '2026-11-14'").get() as
      { tokensAwarded: number; streak: number };
    // 不补 Token：漏签那天本来就没挣到，补了又发币等于签到可以花钱买。
    expect(day.tokensAwarded).toBe(0);
    expect(day.streak).toBe(4);
    expect((await shop(alice)).balance).toBe(before - 30);

    // 当月再补：被「每月 1 次」挡住。
    const sameMonth = await alice.redeem('makeup', '2026-11-14');
    expect(sameMonth.status).toBe(429);
    expect(await sameMonth.json()).toMatchObject({ error: { code: 'MONTHLY_LIMIT' } });

    // 跨月后月配额恢复，但昨天真的已经签过了 -> 靠「已签到」挡住，不再扣钱。
    // 先造出那天的签到记录，否则命中的会是「连续断了」那条更早的判据。
    clock = new Date('2026-12-02T04:00:00Z');
    server.db.prepare('INSERT INTO checkins (userHandle,date,tokensAwarded,streak) VALUES (?,?,?,?)').run('alice', '2026-12-01', 13, 6);
    const balanceBefore = (await shop(alice)).balance;
    const nextMonth = await alice.redeem('makeup', '2026-12-01');
    expect(nextMonth.status).toBe(409);
    expect(await nextMonth.json()).toMatchObject({ error: { code: 'ALREADY_CHECKED_IN' } });
    // 没扣钱：被挡下的兑换不能留下任何痕迹。
    expect((await shop(alice)).balance).toBe(balanceBefore);
  });

  it('补签卡不能补前天，也补不了已经断掉的连续', async () => {
    const alice = await account('alice');
    server.db.prepare("UPDATE token_ledger SET balanceAfter = 1000 WHERE handle = 'alice'").run();
    expect((await alice.redeem('makeup', '2026-11-12')).status).toBe(400);
    // 一条签到都没有 → 连续记录断了，补也接不上。
    const noStreak = await alice.redeem('makeup', '2026-11-14');
    expect(noStreak.status).toBe(409);
    expect(await noStreak.json()).toMatchObject({ error: { code: 'STREAK_UNRECOVERABLE' } });
  });

  it('同一个来源事件只能入账一次（onceKey 幂等）', async () => {
    // 业务层已经挡住了重复签到，但那是「先读后写」；这条是防止并发或将来
    // 别的调用方把同一件事记两遍。要单独测这一层，否则删掉 onceKey 也照样绿。
    const alice = await account('alice');
    const { appendLedger, balanceOf } = await import('../src/tokens.ts');
    const store = server.store;
    const at = clock.toISOString();
    server.store.transaction(() => {
      appendLedger(store, { handle: 'alice', delta: 10, reason: 'checkin', onceKey: 'checkin:2026-11-15', at });
      appendLedger(store, { handle: 'alice', delta: 10, reason: 'checkin', onceKey: 'checkin:2026-11-15', at });
    });
    // 只数签到那些行：注册赠币本身也带 onceKey。
    expect(server.db.prepare("SELECT count(*) AS c FROM token_ledger WHERE handle = 'alice' AND onceKey LIKE 'checkin:%'").get()).toEqual({ c: 1 });
    expect(balanceOf(store, 'alice')).toBe(130);
    // 不同 onceKey 才另记一笔。
    server.store.transaction(() => {
      appendLedger(store, { handle: 'alice', delta: 10, reason: 'checkin', onceKey: 'checkin:2026-11-16', at });
    });
    expect(balanceOf(store, 'alice')).toBe(140);
    void alice;
  });

  it('未登录拿不到余额也兑换不了', async () => {
    expect((await server.app.request('/api/me/tokens')).status).toBe(401);
    expect((await server.app.request('/api/me/tokens/ledger')).status).toBe(401);
    const redeem = await server.app.request('/api/me/tokens/redeem', {
      method: 'POST', headers: json, body: JSON.stringify({ itemKey: 'export', idempotencyKey: 'anon-key-0001' }),
    });
    expect(redeem.status).toBe(401);
  });

  it('不存在的兑换项直接拒绝', async () => {
    const alice = await account('alice');
    const response = await alice.redeem('rank-boost');
    expect(response.status).toBe(400);
  });

  it('管理员可以直接加减 Token，流水里留下理由', async () => {
    const alice = await account('alice');
    const granted = await server.app.request('/api/admin/accounts/alice/tokens', {
      method: 'POST', headers: bearer, body: JSON.stringify({ delta: 200, memo: '补偿上次抽奖' }),
    });
    expect(granted.status).toBe(200);
    expect((await shop(alice)).balance).toBe(320);
    expect(await ledger(alice)).toContainEqual(expect.objectContaining({ delta: 200, reason: 'admin_grant', memo: '补偿上次抽奖' }));

    const deducted = await server.app.request('/api/admin/accounts/alice/tokens', {
      method: 'POST', headers: bearer, body: JSON.stringify({ delta: -1000, memo: '扣回' }),
    });
    // 不能扣成负数：余额是余额，不是信用额度。
    expect(deducted.status).toBe(409);
    expect((await shop(alice)).balance).toBe(320);

    // 没有理由不许改：流水就是审计日志，一条没有理由的负数让人无从解释。
    const noMemo = await server.app.request('/api/admin/accounts/alice/tokens', {
      method: 'POST', headers: bearer, body: JSON.stringify({ delta: 10 }),
    });
    expect(noMemo.status).toBe(400);
  });
});
