import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { callsTo, renderApp, stubApi } from './helpers';

// 审核台的「撤销上次修改」与举报版本提示。这两处都是防误操作的：
// 一个是把误批退回去，一个是别拿新版内容去判断旧版的举报。

async function unlock() {
  renderApp('/admin');
  fireEvent.change(await screen.findByLabelText('管理密钥'), { target: { value: 'x'.repeat(32) } });
  fireEvent.click(screen.getByRole('button', { name: '进入' }));
  await screen.findByRole('heading', { name: '审核台' });
}

beforeEach(() => {
  // 管理密钥存在 sessionStorage 里，用例之间要清掉，否则第二个用例不会走输入流程。
  sessionStorage.clear();
});

const post = (patch: Record<string, unknown> = {}) => ({
  id: 'p1', kind: 'community', title: '改过的文章', summary: '摘要', authorHandle: 'demo-pedal',
  stationSlug: null, modelSlug: null, publishedAt: '2026-11-20T00:00:00.000Z',
  status: 'approved', contentVersion: 2, ...patch,
});

describe('撤销上次修改', () => {
  it('只有改过版（contentVersion > 1）的文章才有入口，确认后调回退接口', async () => {
    const fetchMock = stubApi({
      'GET /api/admin/submissions': { items: [], total: 0 },
      'GET /api/admin/posts': ({ url }: { url: URL }) => (
        url.searchParams.get('status') === 'approved'
          ? { items: [post(), post({ id: 'p2', title: '没改过的', contentVersion: 1 })] }
          : { items: [], total: 0 }
      ),
      'POST /api/admin/posts/p1/revert': { postId: 'p1', restoredVersion: 3, title: '初版标题' },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('tab', { name: /已上线文章/ }));
    expect(await screen.findByText('改过的文章')).toBeInTheDocument();

    // 两条文章里只有一个按钮：没改过的那篇不该出现「撤销」。
    expect(screen.getAllByRole('button', { name: '撤销上次修改' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '撤销上次修改' }));
    // 这是不可逆的内容改动，必须先确认。
    fireEvent.click(await screen.findByRole('button', { name: '确认撤销' }));

    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/admin/posts/p1/revert')).toHaveLength(1), { timeout: 8000 });
    expect(await screen.findByText('已退回上一版')).toBeInTheDocument();
  });
});

describe('举报的版本快照', () => {
  const report = (patch: Record<string, unknown> = {}) => ({
    id: 'r1', targetType: 'post', targetId: 'p1', reporterHandle: 'demo-pedal',
    reason: '像广告', detail: null, status: 'open',
    createdAt: '2026-11-20T00:00:00.000Z', handledAt: null,
    targetAlive: true, targetLabel: '改过的文章', targetVersion: 1, currentVersion: 2, ...patch,
  });

  it('举报后文章改过版时，明确标出「举报第 N 版，现在第 M 版」', async () => {
    stubApi({
      'GET /api/admin/submissions': { items: [], total: 0 },
      'GET /api/admin/reports': { items: [report(), report({ id: 'r2', targetVersion: 2, currentVersion: 2 })], total: 2, pageSize: 20, nextCursor: null },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('tab', { name: /举报/ }));
    expect(await screen.findByText('举报第 1 版，现在第 2 版')).toBeInTheDocument();
    // 没改过的只显示一个版本号，不制造噪音。
    expect(screen.getByText('第 2 版')).toBeInTheDocument();
    expect(screen.queryByText('举报第 2 版，现在第 2 版')).toBeNull();
  });
});
