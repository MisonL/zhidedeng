import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makePost, station, vendors } from './fixtures';
import { callsTo, renderApp, stubApi } from './helpers';

const results = { models: vendors[0].models, stations: [station], posts: [makePost('s1', { title: '搜到的文章' })] };

describe('搜索', () => {
  it('提交搜索框跳到 /search?q= 并分组展示', async () => {
    const fetchMock = stubApi({ 'GET /api/search': results });
    renderApp('/business');

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: ' Claude 4 ' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));

    expect(await screen.findByRole('heading', { name: /搜索结果/ })).toBeInTheDocument();
    await waitFor(() => expect(callsTo(fetchMock, 'GET', '/api/search')[0].url.searchParams.get('q')).toBe('Claude 4'));

    const models = await screen.findByRole('region', { name: /模型/ });
    expect(within(models).getByRole('link', { name: /DeepSeek V4/ })).toHaveAttribute('href', '/models/deepseek-v4');
    expect(within(screen.getByRole('region', { name: /中转站/ })).getByRole('link', { name: /云栈/ })).toHaveAttribute('href', '/stations/yunzhan');
    expect(within(screen.getByRole('region', { name: /文章/ })).getByRole('link', { name: '搜到的文章' })).toHaveAttribute('href', '/posts/s1');
  });

  it('空白关键词不跳转', async () => {
    const fetchMock = stubApi({ 'GET /api/search': results });
    renderApp('/business');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(screen.getByRole('heading', { name: '商务合作' })).toBeInTheDocument();
    expect(callsTo(fetchMock, 'GET', '/api/search')).toHaveLength(0);
  });

  it('热门搜索点击跳转，搜索框同步关键词', async () => {
    const fetchMock = stubApi({ 'GET /api/search': results });
    renderApp('/business');

    fireEvent.click(await screen.findByRole('link', { name: 'DeepSeek' }));
    await waitFor(() => expect(callsTo(fetchMock, 'GET', '/api/search')[0].url.searchParams.get('q')).toBe('DeepSeek'));
    expect(screen.getByRole('searchbox')).toHaveValue('DeepSeek');
  });

  it('无结果显示空态', async () => {
    stubApi({ 'GET /api/search': { models: [], stations: [], posts: [] } });
    renderApp('/search?q=nothing');
    expect(await screen.findByText(/没有找到/)).toBeInTheDocument();
  });
});
