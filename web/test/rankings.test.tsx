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
