import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseSlugs, COMPARE_LIMIT } from '../src/pages/Compare';
import { renderApp, stubApi, callsTo } from './helpers';
import { makePost, page, station } from './fixtures';

const realStation = (slug: string, patch = {}) => ({
  ...station, slug, name: `真实 ${slug}`, source: 'user' as const,
  lastConfirmedAt: null, ...patch,
});

describe('对比页的查询参数', () => {
  it('去重、跳过空项、最多 3 个', () => {
    expect(parseSlugs(null)).toEqual([]);
    expect(parseSlugs('')).toEqual([]);
    expect(parseSlugs('a,,b')).toEqual(['a', 'b']);
    expect(parseSlugs('a,a,b')).toEqual(['a', 'b']);
    // 解析不截断：截断会让「链接里第 4 个站」无声消失，页面才会明说只显示前 3 个。
    expect(parseSlugs('a,b,c,d,e')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(parseSlugs(' a , b ')).toEqual(['a', 'b']);
  });
});

describe('站点对比', () => {
  const stations = [
    realStation('a', { lowestRate: 0.5, uptime: 99.1, lastConfirmedAt: '2026-11-20T00:00:00.000Z' }),
    // 混口径场景：没有综合口径报价 → 最低倍率必须是「暂无」，不能拿别的口径顶上。
    realStation('b', { lowestRate: null, uptime: null, score: null, firstTokenLatencyMs: null }),
    // 演示站不参与对比。
    { ...station, slug: 'demo-x', name: '虚构·某站', source: 'demo' as const },
  ];

  it('演示站不出现在可选项里，null 显示「暂无」，并提示倍率口径', async () => {
    stubApi({ 'GET /api/stations': page(stations), 'GET /api/posts': page([makePost('p1')]) });
    renderApp('/compare');

    expect(await screen.findByRole('button', { name: '真实 a' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '真实 b' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '虚构·某站' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '真实 a' }));
    fireEvent.click(screen.getByRole('button', { name: '真实 b' }));

    const table = await screen.findByRole('table');
    // 口径说明必须跟着「最低倍率」出现，否则 0.5x 会被读成「整站最低价」。
    expect(within(table).getByText('仅综合口径，不含按量/打包价')).toBeInTheDocument();
    expect(within(table).getByText('0.5x')).toBeInTheDocument();
    // b 没有综合口径报价 → 暂无；可用率/延迟/得分同样。
    expect(within(table).getAllByText('暂无').length).toBeGreaterThanOrEqual(4);
    // 没有人聊过时不能拿成立时间冒充活跃度。
    expect(within(table).getByText('还没有人聊过')).toBeInTheDocument();
    expect(within(table).getByText('2026-11-20')).toBeInTheDocument();
  });

  it('站点超过一页时能加载更多，不会把后面的站漏掉', async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => realStation(`s${i}`));
    const secondPage = [realStation('late-station')];
    const fetchMock = stubApi({
      'GET /api/stations': ({ url }: { url: URL }) =>
        page(url.searchParams.get('page') === '2' ? secondPage : firstPage, 51, url.searchParams.get('page') === '2' ? 2 : 1),
      'GET /api/posts': page([makePost('p1')]),
    });
    renderApp('/compare');
    expect(await screen.findByRole('button', { name: '真实 s0' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '真实 late-station' })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    expect(await screen.findByRole('button', { name: '真实 late-station' })).toBeInTheDocument();
    expect(callsTo(fetchMock, 'GET', '/api/stations').some(call => call.url.searchParams.get('page') === '2')).toBe(true);
  });

  it('还有下一页时不会把「这一页没有的 slug」误报成不可对比', async () => {
    const firstPage = [realStation('a'), realStation('b')];
    const secondPage = [realStation('late')];
    stubApi({
      'GET /api/stations': ({ url }: { url: URL }) =>
        page(url.searchParams.get('page') === '2' ? secondPage : firstPage, 3, url.searchParams.get('page') === '2' ? 2 : 1),
      'GET /api/posts': page([makePost('p1')]),
    });
    // late 在第二页，第一页还没加载时不能说它「不可对比」。
    renderApp('/compare?s=late');
    expect(await screen.findByRole('button', { name: '真实 a' })).toBeInTheDocument();
    expect(screen.queryByText(/不可对比/)).not.toBeInTheDocument();
  });

  it('选满 3 个后其余选项禁用；已下架的 slug 会被明确提示而不是静默忽略', async () => {
    stubApi({ 'GET /api/stations': page([...stations, realStation('c'), realStation('d')]), 'GET /api/posts': page([makePost('p1')]) });
    renderApp('/compare?s=a,b,c,gone');

    expect(await screen.findByRole('button', { name: '真实 a' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '真实 d' })).toBeDisabled();
    // 4 个 slug 里第 4 个被上限挡掉，必须说出来。
    expect(screen.getByText(new RegExp(`多出的 1 个没有显示`))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '真实 b' })).toHaveAttribute('aria-pressed', 'true');
  });
});
