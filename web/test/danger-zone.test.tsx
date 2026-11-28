import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callsTo, renderApp, stubApi } from './helpers';

// 不用 vi.mock：这个仓库的 vitest 配置是 --no-isolate，模块 mock 会跨文件泄漏，
// 别处 renderApp 的 useCatalog 就被换成了空实现。统一走 stubApi 打桩 fetch。

describe('注销账号的危险区域', () => {
  let fetchMock: ReturnType<typeof stubApi>;
  const assign = vi.fn();

  beforeEach(() => {
    fetchMock = stubApi({
      'POST /api/me/delete': () => ({ ok: true, deletedAt: '2026-11-08T00:00:00.000Z' }),
    });
    // jsdom 不实现导航，window.location.assign 会抛「Not implemented」。
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { assign } });
    assign.mockReset();
  });

  const open = async () => {
    renderApp('/me?tab=settings');
    fireEvent.click(await screen.findByRole('button', { name: '我要注销账号' }));
  };

  it('默认收起，点开后才出现口令与确认框', async () => {
    renderApp('/me?tab=settings');
    await screen.findByRole('button', { name: '我要注销账号' });
    // 收起时表单不在页面里：一进设置页就摆着删除账号的输入框太容易误触。
    expect(screen.queryByLabelText('你的密码')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '我要注销账号' }));
    expect(screen.getByLabelText('你的密码')).toBeTruthy();
    expect(screen.getByLabelText('输入「注销」两个字确认')).toBeTruthy();
  });

  it('口令与确认短语一起提交，成功后整页回到首页', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('你的密码'), { target: { value: 'correct-horse-battery' } });
    fireEvent.change(screen.getByLabelText('输入「注销」两个字确认'), { target: { value: '注销' } });
    fireEvent.click(screen.getByRole('button', { name: '确认注销' }));

    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/me/delete')).toHaveLength(1));
    // 两个凭据都要真的发出去：只发 confirm 等于没有二次校验。
    expect(callsTo(fetchMock, 'POST', '/api/me/delete')[0].body).toEqual({ password: 'correct-horse-battery', confirm: '注销' });
    // 注销后会话已失效，不能再去取 /api/me（只会 401 并弹错误）；要整页跳走。
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('服务端拒绝时显示原因，保持可重新填写', async () => {
    fetchMock = stubApi({
      'POST /api/me/delete': () => new Response(
        JSON.stringify({ error: { code: 'WRONG_PASSWORD', message: '密码不正确' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    });
    await open();
    fireEvent.change(screen.getByLabelText('你的密码'), { target: { value: 'wrong-password-x' } });
    fireEvent.change(screen.getByLabelText('输入「注销」两个字确认'), { target: { value: '注销' } });
    fireEvent.click(screen.getByRole('button', { name: '确认注销' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('密码不正确'));
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '确认注销' })).not.toBeDisabled();
  });
});
