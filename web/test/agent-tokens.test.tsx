import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { apiError, callsTo, deferred, renderApp, stubApi } from './helpers';

const PATH = '/api/account/agent-tokens';
const token = {
  id: 'agent-1', label: '本地 Agent', tokenPrefix: 'zd_AAAAA\u2026', createdAt: '2026-11-08T04:00:00.000Z',
  lastUsedAt: null, useCount: 0, revokedAt: null, status: 'active',
};
const issued = { id: token.id, label: token.label, tokenPrefix: token.tokenPrefix, createdAt: token.createdAt, token: 'zd_' + 'A'.repeat(43) };
const open = async () => {
  renderApp('/me?tab=settings');
  await screen.findByRole('heading', { name: 'AI Agent 凭证' });
};

describe('账户设置里的 Agent 凭证', () => {
  it('列出前缀、使用次数和吊销状态，未使用时间保持未知语义', async () => {
    stubApi({ ['GET ' + PATH]: [token, { ...token, id: 'agent-2', label: '旧 Agent', status: 'revoked', revokedAt: token.createdAt, useCount: 7, lastUsedAt: token.createdAt }] });
    await open();
    expect(await screen.findByText('本地 Agent')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Agent 凭证列表' });
    expect(within(table).getAllByText(token.tokenPrefix)).toHaveLength(2);
    expect(within(table).getByText('尚未使用')).toBeInTheDocument();
    expect(within(table).getByText('活跃')).toBeInTheDocument();
    expect(within(table).getByText('已吊销')).toBeInTheDocument();
    expect(within(table).getByText('7')).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: '吊销 本地 Agent' })).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: '吊销 旧 Agent' })).not.toBeInTheDocument();
  });

  it('生成时发送标签和可选邀请码，明文只展示到用户主动隐藏', async () => {
    let items: unknown[] = [];
    const fetchMock = stubApi({
      ['GET ' + PATH]: () => items,
      ['POST ' + PATH]: () => { items = [token]; return issued; },
    });
    await open();
    await screen.findByText('暂无 Agent 凭证');
    fireEvent.change(screen.getByLabelText('凭证名称'), { target: { value: ' 本地 Agent ' } });
    fireEvent.change(screen.getByLabelText('邀请码（可选）'), { target: { value: ' invite-first ' } });
    fireEvent.click(screen.getByRole('button', { name: '生成凭证' }));
    expect(await screen.findByLabelText('新凭证明文')).toHaveValue(issued.token);
    expect(callsTo(fetchMock, 'POST', PATH)[0].body).toEqual({ label: '本地 Agent', inviteCode: 'invite-first' });
    expect(screen.getByRole('button', { name: '生成凭证' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '已保存，隐藏凭证' }));
    expect(screen.queryByLabelText('新凭证明文')).not.toBeInTheDocument();
    expect(await screen.findByText('本地 Agent')).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('签发成功后列表刷新失败仍保留一次性明文', async () => {
    let reads = 0;
    stubApi({ ['GET ' + PATH]: () => ++reads === 1 ? [] : apiError(503, 'BUSY', '数据库繁忙'), ['POST ' + PATH]: issued });
    await open();
    await screen.findByText('暂无 Agent 凭证');
    fireEvent.change(screen.getByLabelText('凭证名称'), { target: { value: '本地 Agent' } });
    fireEvent.click(screen.getByRole('button', { name: '生成凭证' }));
    expect(await screen.findByLabelText('新凭证明文')).toHaveValue(issued.token);
    expect(await screen.findByText('数据库繁忙')).toBeInTheDocument();
    expect(screen.getByLabelText('新凭证明文')).toHaveValue(issued.token);
  });

  it('未满足准入时显示服务端原因，失败不伪装成生成成功', async () => {
    stubApi({ ['GET ' + PATH]: [], ['POST ' + PATH]: () => apiError(403, 'ELIGIBILITY_REQUIRED', '注册未满 7 天，请完成投稿或填写邀请码') });
    await open();
    await screen.findByText('暂无 Agent 凭证');
    fireEvent.change(screen.getByLabelText('凭证名称'), { target: { value: 'Agent' } });
    fireEvent.click(screen.getByRole('button', { name: '生成凭证' }));
    expect(await screen.findByText('注册未满 7 天，请完成投稿或填写邀请码')).toBeInTheDocument();
    expect(screen.queryByLabelText('新凭证明文')).not.toBeInTheDocument();
  });

  it('成功吊销后保留列表记录并显示已吊销，DELETE 仍带 JSON Content-Type', async () => {
    const fetchMock = stubApi({ ['GET ' + PATH]: [token], ['DELETE ' + PATH + '/' + token.id]: { id: token.id, revokedAt: token.createdAt } });
    await open();
    fireEvent.click(await screen.findByRole('button', { name: '吊销 本地 Agent' }));
    expect(await screen.findByText('已吊销')).toBeInTheDocument();
    expect(screen.getByText('本地 Agent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '吊销 本地 Agent' })).not.toBeInTheDocument();
    const [, init] = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')!;
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('吊销失败保留活跃状态并允许重试', async () => {
    stubApi({ ['GET ' + PATH]: [token], ['DELETE ' + PATH + '/' + token.id]: () => apiError(503, 'BUSY', '吊销失败，请重试') });
    await open();
    fireEvent.click(await screen.findByRole('button', { name: '吊销 本地 Agent' }));
    expect(await screen.findByText('吊销失败，请重试')).toBeInTheDocument();
    expect(screen.getByText('活跃')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '吊销 本地 Agent' })).toBeEnabled();
  });

  it('列表未加载或已有五个活跃凭证时不发生成请求', async () => {
    const pending = deferred<unknown[]>();
    const fetchMock = stubApi({ ['GET ' + PATH]: () => pending.promise });
    await open();
    fireEvent.change(screen.getByLabelText('凭证名称'), { target: { value: '第六个' } });
    expect(screen.getByRole('button', { name: '生成凭证' })).toBeDisabled();
    pending.resolve(Array.from({ length: 5 }, (_, index) => ({ ...token, id: 'agent-' + index, label: 'Agent ' + index })));
    await screen.findByText('Agent 0');
    expect(screen.getByRole('button', { name: '生成凭证' })).toBeDisabled();
    expect(callsTo(fetchMock, 'POST', PATH)).toHaveLength(0);
  });
});
