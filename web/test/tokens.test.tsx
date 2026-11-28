import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { callsTo, renderApp, stubApi } from './helpers';
import { makePost } from './fixtures';

const shop = {
  balance: 130, earned: 200, spent: 10,
  items: [
    { key: 'flower', name: '送一朵花', cost: 5, unit: '朵', description: '给喜欢的文章送花', monthlyLimit: 20, requiresTarget: 'post' },
    { key: 'badge', name: '支持者徽章', cost: 240, unit: '枚', description: '永久挂在主页', monthlyLimit: 1, requiresTarget: null },
    { key: 'export', name: '导出我的数据', cost: 30, unit: '次', description: '导出自己的内容', monthlyLimit: 2, requiresTarget: null },
  ],
  entitlements: [] as string[],
  usedThisMonth: { flower: 1, badge: 0, export: 2 },
};

const ledger = {
  items: [
    { id: 'l2', handle: 'demo-pedal', delta: -5, balanceAfter: 130, reason: 'redeem', memo: '送一朵花（5 Token）', at: '2026-11-15T04:00:00.000Z' },
    { id: 'l1', handle: 'demo-pedal', delta: 120, balanceAfter: 135, reason: 'signup', memo: '注册赠币', at: '2026-11-10T04:00:00.000Z' },
  ],
  total: 2, page: 1, pageSize: 20,
};

describe('Token 页', () => {
  let fetchMock: ReturnType<typeof stubApi>;
  beforeEach(() => {
    fetchMock = stubApi({ 'GET /api/me/tokens': shop, 'GET /api/me/tokens/ledger': ledger });
  });

  it('余额、累计收支、每项本月用量都显示出来', async () => {
    renderApp('/me?tab=tokens');
    // 余额会出现两处（汇总与流水最后一条的 balanceAfter），用 all 查询。
    expect((await screen.findAllByText('130', {}, { timeout: 8000 })).length).toBeGreaterThan(0);
    expect(screen.getByText('累计获得')).toBeTruthy();
    expect(screen.getByText('累计花费')).toBeTruthy();
    // 本月用量决定按钮能不能点，必须可见，否则用户不知道为什么点不动。
    await screen.findByText('本月 1/20', {}, { timeout: 8000 });
    expect(screen.getByText('本月 2/2')).toBeTruthy();
  });

  it('余额不够的项目按钮禁用并显示还差多少', async () => {
    renderApp('/me?tab=tokens');
    // 徽章 240，余额 130。
    await waitFor(() => expect(screen.getByRole('button', { name: '还差 110' })).toBeDisabled(), { timeout: 8000 });
    // 导出本月 2 次已经用完。
    expect(screen.getByRole('button', { name: '本月已用完' })).toBeDisabled();
  });

  it('兑换时带上项目、请求编号和目标；成功后刷新余额', async () => {
    fetchMock = stubApi({
      'GET /api/me/tokens': shop,
      'GET /api/me/tokens/ledger': ledger,
      'POST /api/me/tokens/redeem': {
        order: { id: 'o1', itemKey: 'export', cost: 30, targetType: null, targetId: null, payload: { posts: [] }, createdAt: '2026-11-15T05:00:00.000Z' },
        balance: 100,
      },
    });
    // 导出的本月额度还剩 1 次，按钮才会是可点的「花 30 Token」。
    fetchMock = stubApi({
      'GET /api/me/tokens': { ...shop, usedThisMonth: { flower: 1, badge: 0, export: 1 } },
      'GET /api/me/tokens/ledger': ledger,
      'POST /api/me/tokens/redeem': {
        order: { id: 'o1', itemKey: 'export', cost: 30, targetType: null, targetId: null, payload: { posts: [] }, createdAt: '2026-11-15T05:00:00.000Z' },
        balance: 100,
      },
    });
    renderApp('/me?tab=tokens');
    const button = await screen.findByRole('button', { name: '花 30 Token' }, { timeout: 8000 });
    fireEvent.click(button);

    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/me/tokens/redeem')).toHaveLength(1), { timeout: 8000 });
    const body = callsTo(fetchMock, 'POST', '/api/me/tokens/redeem')[0].body as { itemKey: string; idempotencyKey: string };
    expect(body.itemKey).toBe('export');
    // 每次点击都要新的请求编号：复用旧键会让第二次点击变成「重放」而不扣费。
    expect(body.idempotencyKey.length).toBeGreaterThan(10);
    // 导出结果直接展开给用户看，不用再点一次。
    await waitFor(() => expect(screen.getByLabelText('导出的数据')).toBeTruthy(), { timeout: 8000 });
  });

  it('流水按类型显示中文，正负号与余额都在', async () => {
    renderApp('/me?tab=tokens');
    // 流水每一行是「+120　注册赠币　注册赠币　余额 135　时间」，整行是一个文本
    // 节点，按子串匹配；用精确短语会永远是「找不到」的假绿。
    const rows = await screen.findAllByText((_, node) => node?.tagName === 'LI' && (node.textContent ?? '').includes('注册赠币'), {}, { timeout: 8000 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(row => (row.textContent ?? '').includes('+120'))).toBe(true);
    expect(rows.some(row => (row.textContent ?? '').includes('余额 135'))).toBe(true);
    const redeemRow = await screen.findByText((_, node) => node?.tagName === 'LI' && (node.textContent ?? '').includes('-5'), {}, { timeout: 8000 });
    expect(redeemRow.textContent).toContain('兑换');
    expect(await screen.findByText('+120', {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByText('-5')).toBeTruthy();
  });
});

describe('文章页送花', () => {
  it('别人的已上线文章才有送花按钮，点了带上文章 id', async () => {
    const fetchMock = stubApi({
      'GET /api/posts/p1': makePost('p1', {
        source: 'user', author: { handle: 'someone-else', nickname: '别人', avatar: '' },
      }),
      'POST /api/me/tokens/redeem': {
        order: { id: 'o1', itemKey: 'flower', cost: 5, targetType: 'post', targetId: 'p1', payload: null, createdAt: '2026-11-15T05:00:00.000Z' },
        balance: 125,
      },
    });
    renderApp('/posts/p1');
    const button = await screen.findByRole('button', { name: '送一朵花（5 Token）' }, { timeout: 8000 });
    fireEvent.click(button);
    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/me/tokens/redeem')).toHaveLength(1), { timeout: 8000 });
    expect(callsTo(fetchMock, 'POST', '/api/me/tokens/redeem')[0].body).toMatchObject({ itemKey: 'flower', targetId: 'p1' });
    await screen.findByText('已送花 🌸', {}, { timeout: 8000 });
  });

  it('自己的文章不显示送花按钮', async () => {
    stubApi({ 'GET /api/posts/p1': makePost('p1', { source: 'user' }) });
    renderApp('/posts/p1');
    await screen.findByText('爆料 p1');
    expect(screen.queryByRole('button', { name: /送一朵花/ })).toBeNull();
  });
});
