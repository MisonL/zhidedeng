import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp, stubApi } from './helpers';
import { me, page } from './fixtures';

const item = (id: string, patch = {}) => ({
  id, kind: 'submission' as const, title: `通知 ${id}`, detail: null as string | null,
  href: null as string | null, at: '2026-11-24T00:00:00.000Z', ...patch,
});

describe('我的通知', () => {
  it('三类事件各显示自己的标签与标题，驳回理由带出来', async () => {
    stubApi({
      'GET /api/me': me,
      'GET /api/me/notifications': page([
        item('n1', { kind: 'submission', title: '你投稿的文章「甲」未通过', detail: '用了真实站点名' }),
        item('n2', { kind: 'report', title: '你举报的内容已处理', detail: '已下架', href: '/posts/p1' }),
        item('n3', { kind: 'post', title: '你的文章「乙」已下架' }),
      ]),
    });
    renderApp('/me?tab=notifications');

    expect(await screen.findByText('你投稿的文章「甲」未通过', {}, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByText('用了真实站点名')).toBeInTheDocument();
    expect(screen.getByText('投稿')).toBeInTheDocument();
    expect(screen.getByText('举报')).toBeInTheDocument();
    expect(screen.getByText('文章')).toBeInTheDocument();
    // 有 href 的那条是链接，没有的不能做成链接（点进去 404）。
    expect(screen.getByRole('link', { name: /你举报的内容已处理/ })).toHaveAttribute('href', '/posts/p1');
    expect(screen.queryByRole('link', { name: /你的文章「乙」已下架/ })).not.toBeInTheDocument();
  });

  it('没有通知时给空态，不是一片空白', async () => {
    stubApi({ 'GET /api/me': me, 'GET /api/me/notifications': page([]) });
    renderApp('/me?tab=notifications');
    expect(await screen.findByText('还没有通知', {}, { timeout: 15000 })).toBeInTheDocument();
  });

  it('分页：还有下一页时能加载更多', async () => {
    const first = Array.from({ length: 20 }, (_, index) => item(`a${index}`, { title: `第一页 ${index}` }));
    stubApi({
      'GET /api/me': me,
      'GET /api/me/notifications': ({ url }: { url: URL }) =>
        page(url.searchParams.get('page') === '2' ? [item('b1', { title: '第二页那条' })] : first, 21,
          url.searchParams.get('page') === '2' ? 2 : 1),
    });
    renderApp('/me?tab=notifications');
    expect(await screen.findByText('第一页 0')).toBeInTheDocument();
    expect(screen.queryByText('第二页那条')).not.toBeInTheDocument();
  });
});
