import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

// 编辑页的关键行为：被拒时预填「被拒那一版」而不是线上版。
const getPost = vi.fn();
const getRevision = vi.fn();
vi.mock('../src/api', () => ({
  api: {
    getPost: (...args: unknown[]) => getPost(...args),
    getRevision: (...args: unknown[]) => getRevision(...args),
    submitRevision: vi.fn(),
    withdrawRevision: vi.fn(),
  },
}));
vi.mock('../src/state', () => ({
  useMe: () => ({ data: { handle: 'alice', nickname: 'alice', avatar: null, bio: '', tokens: 0, shareCount: 1, upCount: 0, joinedAt: null }, refreshMe: vi.fn(), setMe: vi.fn() }),
  useCatalog: () => ({ data: { stations: [], vendors: [] } }),
  useToast: () => vi.fn(),
}));
vi.mock('../src/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hooks')>();
  return actual;
});

import PostEdit from '../src/pages/PostEdit';

const live = {
  id: 'p1', kind: 'community', title: '线上标题', summary: '线上摘要', body: '线上正文',
  author: { handle: 'alice', nickname: 'alice', avatar: null }, stationSlug: null, modelSlug: null,
  cover: null, publishedAt: '2026-11-01T00:00:00.000Z', source: 'user', status: 'approved',
  votes: 0, currentUserVote: null, favorited: false, favoriteCount: 0, commentCount: 0,
  contentVersion: 2, revisedAt: null,
};

function renderEdit() {
  return render(
    <MemoryRouter initialEntries={['/posts/p1/edit']}>
      <Routes>
        <Route path="/posts/:id/edit" element={<PostEdit />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('编辑文章页', () => {
  it('被拒时预填被拒那一版，不是线上版', async () => {
    getPost.mockResolvedValue(live);
    getRevision.mockResolvedValue({
      revision: {
        submissionId: 's1', status: 'rejected', reviewReason: '正文里写了绝对价格',
        submittedAt: '2026-11-02T00:00:00.000Z',
        payload: { kind: 'community', title: '被拒的标题', summary: '被拒摘要', body: '被拒正文', stationSlug: null, modelSlug: null },
      },
    });
    renderEdit();
    await waitFor(() => expect(screen.getByLabelText('标题')).toHaveValue('被拒的标题'));
    expect(screen.getByLabelText('摘要')).toHaveValue('被拒摘要');
    // 线上版的内容一个都不该出现在表单里。
    expect(screen.getByLabelText(/^正文/)).not.toHaveValue('线上正文');
    expect(screen.getByText(/正文里写了绝对价格/)).toBeTruthy();
  });

  it('没有修改时预填线上版，并显示当前版本号', async () => {
    getPost.mockResolvedValue(live);
    getRevision.mockResolvedValue({ revision: null });
    renderEdit();
    await waitFor(() => expect(screen.getByLabelText('标题')).toHaveValue('线上标题'));
    expect(screen.getByText(/当前版本第 2 版/)).toBeTruthy();
  });

  it('有待审修改时禁用提交按钮并给出撤回入口', async () => {
    getPost.mockResolvedValue(live);
    getRevision.mockResolvedValue({
      revision: {
        submissionId: 's2', status: 'pending', reviewReason: null, submittedAt: '2026-11-03T00:00:00.000Z',
        payload: { kind: 'community', title: '待审标题', summary: 's', body: 'b', stationSlug: null, modelSlug: null },
      },
    });
    renderEdit();
    await waitFor(() => expect(screen.getByText(/已有一版修改在审核中/)).toBeTruthy());
    expect(screen.getByRole('button', { name: '有一版在审核中' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '撤回修改' })).toBeTruthy();
  });
});
