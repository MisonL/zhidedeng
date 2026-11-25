import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { callsTo, renderApp, stubApi } from './helpers';

const makeReport = (id: string) => ({
  id, targetType: 'comment' as const, targetId: `c-${id}`, reporterHandle: 'demo-pedal',
  reason: `理由 ${id}`, detail: null, status: 'open' as const,
  createdAt: '2026-11-20T00:00:00.000Z', handledAt: null, targetAlive: true, targetLabel: `评论 ${id}`,
});

async function unlock() {
  renderApp('/admin');
  fireEvent.change(await screen.findByLabelText('管理密钥'), { target: { value: 'x'.repeat(32) } });
  fireEvent.click(screen.getByRole('button', { name: '进入' }));
  await screen.findByRole('heading', { name: '审核台' });
}

describe('probe', () => {
  it('C: 空页后加载更多死循环', async () => {
    stubApi({
      'GET /api/admin/reports': ({ url }: { url: URL }) => {
        const page = Number(url.searchParams.get('page') ?? 1);
        // total=3，但第 2 页只有与第 1 页重复的行（offset 错位），第 3 页起为空
        return {
          items: page === 1 ? [makeReport('a'), makeReport('b')] : page === 2 ? [makeReport('a'), makeReport('b')] : [],
          total: 3, page, pageSize: 20,
        };
      },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('tab', { name: /举报/ }));
    await screen.findByText('理由 a');
    fireEvent.click(screen.getByRole('button', { name: /加载更多/ }));
    await waitFor(() => expect(callsTo((globalThis as any).fetch, 'GET', '/api/admin/reports')).toBeTruthy());
    // 页面 2 全是重复项，去重后列表仍是 2 条
    await screen.findByRole('button', { name: /加载更多（还有 1 条）/ });
    fireEvent.click(screen.getByRole('button', { name: /加载更多/ }));
    // 第 3 页为空，列表仍 2 条，按钮却还在 → 可无限点
    await screen.findByRole('button', { name: /加载更多（还有 1 条）/ });
    fireEvent.click(screen.getByRole('button', { name: /加载更多/ }));
    await screen.findByRole('button', { name: /加载更多（还有 1 条）/ });
  });

  it('A: 翻到第 2 页后处置一条，列表被重置回第 1 页', async () => {
    const fetchMock = stubApi({
      'GET /api/admin/reports': ({ url }: { url: URL }) => {
        const page = Number(url.searchParams.get('page') ?? 1);
        return {
          items: page === 1 ? [makeReport('a'), makeReport('b')] : [makeReport('c')],
          total: page === 1 ? 3 : 3, page, pageSize: 2,
        };
      },
      'POST /api/admin/reports/r-a/resolve': { id: 'a', status: 'resolved' },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('tab', { name: /举报/ }));
    await screen.findByText('理由 a');
    fireEvent.click(screen.getByRole('button', { name: /加载更多/ }));
    await screen.findByText('理由 c');
    // 对第 2 页的 c 处置
    const btns = screen.getAllByRole('button', { name: '处理…' });
    fireEvent.click(btns.at(-1)!);
    fireEvent.click(screen.getAllByRole('button', { name: '已处理' }).at(-1)!);
    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/admin/reports/r-c/resolve')).toEqual([]));
    // 列表是否回到只含第 1 页？观察理由 c 是否消失
    await waitFor(() => expect(screen.queryByText('理由 c')).not.toBeInTheDocument());
  });

  it('A2: 第 1 页处置一条后按钮数字', async () => {
    const fetchMock = stubApi({
      'GET /api/admin/reports': ({ url }: { url: URL }) => {
        const page = Number(url.searchParams.get('page') ?? 1);
        const total = callsTo(fetchMock, 'GET', '/api/admin/reports').length > 1 ? 2 : 3;
        return {
          items: page === 1 ? [makeReport('a'), makeReport('b')] : [makeReport('c')],
          total, page, pageSize: 2,
        };
      },
      'POST /api/admin/reports/r-a/resolve': { id: 'a', status: 'resolved' },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('tab', { name: /举报/ }));
    await screen.findByText('理由 a');
    fireEvent.click(screen.getAllByRole('button', { name: '处理…' })[0]);
    fireEvent.click(screen.getByRole('button', { name: '已处理' }));
    await screen.findByText('已标记处理');
    // 页签数字 = total 2；列表 2 条 → 一致
    expect(screen.getByRole('tab', { name: /举报/ }).textContent).toContain('(2)');
  });
});
