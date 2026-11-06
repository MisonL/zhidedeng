import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PostCard from '../src/components/PostCard';
import { ExpertTile } from '../src/components/visuals';
import { makePost, me, station, vendors } from './fixtures';
import { apiError, callsTo, renderApp, renderWithProviders, stubApi } from './helpers';

describe('模型比价表', () => {
  it('并列最低的站点都标「最低」', async () => {
    const offer = (stationSlug: string, rate: number) => ({ stationSlug, modelSlug: 'deepseek-v4', rate, station: { ...station, slug: stationSlug, name: stationSlug } });
    stubApi({ 'GET /api/models/deepseek-v4': { ...vendors[0].models[0], offers: [offer('a', 0.5), offer('b', 0.5), offer('c', 0.8)] } });
    renderApp('/models/deepseek-v4');
    const row = async (name: string) => (await screen.findByRole('link', { name })).closest('tr');
    expect(await row('a')).toHaveClass('is-best');
    expect(await row('b')).toHaveClass('is-best');
    expect(await row('c')).not.toHaveClass('is-best');
  });
});

describe('头像与封面取字', () => {
  const glyph = (nickname: string) => {
    const { container } = renderWithProviders(<ExpertTile nickname={nickname} />);
    return container.querySelector('.cover-expert')!.getAttribute('data-glyph');
  };

  it('昵称只有演示前缀时回退到原名首字，不留空白', () => {
    stubApi();
    expect(glyph('虚构')).toBe('虚');
    expect(glyph('虚构·')).toBe('虚');
    expect(glyph('虚构·大肥鱼')).toBe('大');
    expect(glyph('虚构饭团')).toBe('饭');
  });

  it('封面只去掉标题里的站名前缀，用户自己写的间隔号保持原样', async () => {
    stubApi({ 'GET /api/stations': { items: [{ ...station, name: '虚构·云栈' }], total: 1, page: 1, pageSize: 10 } });
    const { container } = renderWithProviders(
      <>
        <PostCard post={makePost('seed', { kind: 'guide', title: '云栈 · 先测稳定再看倍率' })} />
        <PostCard post={makePost('user', { kind: 'community', title: '问题 · 补充说明' })} />
      </>,
    );
    await waitFor(() => expect(container.querySelector('.cover-guide .cover-pitch')).toHaveAttribute('data-pitch', '先测稳定再看倍率'));
    expect(container.querySelector('.cover-community .cover-pitch')).toHaveAttribute('data-pitch', '问题 · 补充说明');
  });
});

describe('手机端导航与用户条', () => {
  it('次要导航项和用户入口用 className 标记，加载失败的重试按钮同样可截断', async () => {
    stubApi({ 'GET /api/me': apiError(500, 'INTERNAL', '用户服务异常') });
    renderApp('/docs');
    expect(await screen.findByRole('button', { name: '用户加载失败，重试' })).toHaveClass('nav-me');
    const nav = within(screen.getByRole('navigation', { name: '主导航' }));
    expect(nav.getByRole('link', { name: 'API文档' })).toHaveClass('nav-secondary');
    expect(nav.getByRole('link', { name: '商务合作' })).toHaveClass('nav-secondary');
  });

  it('用户入口带 nav-me', async () => {
    stubApi();
    renderApp('/docs');
    expect(await screen.findByRole('button', { name: me.nickname })).toHaveClass('nav-me');
  });

  it('手机宽度下不挂载「我已经分享」，也不请求它的数据', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 760px)', media: query, addEventListener: () => {}, removeEventListener: () => {},
    }));
    const fetchMock = stubApi();
    renderApp('/');
    expect(await screen.findByRole('button', { name: '签到领Token' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '我已经分享' })).not.toBeInTheDocument();
    expect(callsTo(fetchMock, 'GET', '/api/me/posts')).toHaveLength(0);
  });

  it('桌面宽度照常显示「我已经分享」', async () => {
    stubApi();
    renderApp('/');
    expect(await screen.findByRole('heading', { name: '我已经分享' })).toBeInTheDocument();
  });
});
