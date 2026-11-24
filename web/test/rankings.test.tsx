import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import RankingBoard from '../src/components/RankingBoard';
import { rankings } from './fixtures';
import { apiError, callsTo, renderApp, renderWithProviders, stubApi } from './helpers';

describe('排行榜', () => {
  it('切换模型/社区/达人 tab 重新取数', async () => {
    const fetchMock = stubApi();
    renderWithProviders(<RankingBoard />);

    expect(await screen.findByText('DeepSeek V4')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '模型' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/低至 0.5x/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '社区' }));
    expect(await screen.findByText('社区热帖一号')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '社区' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: '达人' }));
    expect(await screen.findByText('蹬车达人')).toBeInTheDocument();

    const tabs = callsTo(fetchMock, 'GET', '/api/rankings').map(({ url }) => url.searchParams.get('tab'));
    expect(tabs).toEqual(['model', 'community', 'expert']);
    expect(screen.getByRole('link', { name: /查看更多/ })).toHaveAttribute('href', '/rank?tab=expert');
  });

  it('榜单为空时给出说明与下一步，而不是一个白块', async () => {
    // 空库时原来渲染的是空的 .rank-grid：首页最显眼的模块是一片空白，
    // 看起来像页面坏了。返回体是 {items,total,tab} 而不是数组，
    // 所以 AsyncView 的默认空态判定根本不生效，必须显式传 isEmpty。
    const empty = (tab: 'model' | 'community' | 'expert') => ({ total: 0, page: 1, pageSize: 6, tab, items: [] });
    stubApi({
      'GET /api/rankings': ({ url }: { url: URL }) => empty(url.searchParams.get('tab') as 'model'),
    });
    renderWithProviders(<RankingBoard />);
    expect(await screen.findByText(/目录里还没有模型，模型榜暂时为空/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '社区' }));
    expect(await screen.findByText(/还没有已通过的社区文章，社区榜暂时为空/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '达人' }));
    expect(await screen.findByText(/达人榜暂时为空/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '去写第一篇' })).toHaveAttribute('href', '/submit');
  });

  it('取数失败显示错误，可重试', async () => {
    let attempts = 0;
    stubApi({ 'GET /api/rankings': () => (++attempts === 1 ? apiError(500, 'INTERNAL', '榜单异常') : rankings('model')) });
    renderWithProviders(<RankingBoard />);

    expect(await screen.findByText('榜单异常')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('link', { name: /DeepSeek V4/ })).toBeInTheDocument();
  });

  it('/rank 页按 URL 选中 tab，切换写回 URL', async () => {
    const fetchMock = stubApi();
    renderApp('/rank?tab=community');
    expect(await screen.findByText('社区热帖一号')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '达人' }));
    expect(await screen.findByText('蹬车达人')).toBeInTheDocument();
    await waitFor(() => expect(callsTo(fetchMock, 'GET', '/api/rankings').at(-1)?.url.searchParams.get('pageSize')).toBe('12'));
  });
});
