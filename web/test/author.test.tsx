import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp, stubApi, callsTo } from './helpers';
import { makePost, page } from './fixtures';

const profile = {
  handle: 'alice', nickname: '爱丽丝', avatar: '', bio: '只写真实的',
  shareCount: 2, upCount: 7, joinedAt: '2026-01-02T00:00:00.000Z',
};

describe('作者主页', () => {
  it('展示公开资料与 TA 的文章，并按作者过滤请求', async () => {
    const fetchMock = stubApi({
      'GET /api/users/alice': profile,
      'GET /api/posts': page([
        makePost('a1', { title: '爱丽丝写的第一篇', author: { handle: 'alice', nickname: '爱丽丝', avatar: '' } }),
      ]),
    });
    renderApp('/u/alice');

    expect(await screen.findByRole('heading', { name: '爱丽丝' })).toBeInTheDocument();
    expect(screen.getByText('只写真实的')).toBeInTheDocument();
    // 页头统计里同时有篇数和赞数，按文案定位避免撞到文章卡上的数字。
    expect(screen.getByText(/个赞/).textContent).toContain('7');
    expect(await screen.findByText('爱丽丝写的第一篇')).toBeInTheDocument();
    // 过滤条件必须真的带上，否则这个页面会把全站文章当成 TA 的。
    expect(callsTo(fetchMock, 'GET', '/api/posts').at(-1)!.url.searchParams.get('author')).toBe('alice');
  });

  it('没有这个作者时说明白，而不是给一个空白主页', async () => {
    stubApi({
      'GET /api/users/nobody': { error: { code: 'NOT_FOUND', message: '没有这个作者' } },
      'GET /api/posts': page([]),
    });
    // 上面那个桩返回的是数据体，这里换成真正的 404 响应。
    const { apiError } = await import('./helpers');
    stubApi({
      'GET /api/users/nobody': apiError(404, 'NOT_FOUND', '没有这个作者'),
      'GET /api/posts': page([]),
    });
    renderApp('/u/nobody');
    expect(await screen.findByText('没有这个作者')).toBeInTheDocument();
  });

  it('文章卡片的作者名指向作者主页', async () => {
    // stationSlug 为 null 时卡片才显示作者名（有站点时显示的是站点）。
    stubApi({
      'GET /api/posts': page([makePost('p1', {
        title: '某篇', stationSlug: null,
        author: { handle: 'bob', nickname: '鲍勃', avatar: '' },
      })]),
    });
    renderApp('/community');
    const link = await screen.findByRole('link', { name: '鲍勃' });
    expect(link).toHaveAttribute('href', '/u/bob');
  });
});
