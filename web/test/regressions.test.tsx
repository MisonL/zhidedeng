import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PostCard from '../src/components/PostCard';
import UserCard from '../src/components/UserCard';
import { formatDate } from '../src/format';
import { makePost, me, page, station } from './fixtures';
import { apiError, callsTo, deferred, json, renderApp, renderWithProviders, stubApi } from './helpers';
import type { StubRequest } from './helpers';

const stat = (label: string) => screen.getByText(label, { selector: 'dt' }).parentElement!;

describe('投稿类型跟随 URL', () => {
  function fillAndPublish() {
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '标题' } });
    fireEvent.change(screen.getByLabelText('摘要'), { target: { value: '摘要' } });
    fireEvent.change(screen.getByLabelText(/^正文/), { target: { value: '正文' } });
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));
  }

  it('在投稿页点导航切换类型后，单选框和提交的类型都更新，已填内容保留', async () => {
    const created = makePost('new1');
    const fetchMock = stubApi({ 'POST /api/posts': created, 'GET /api/posts/new1': created });
    renderApp('/submit?kind=deal');
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '写了一半' } });

    fireEvent.click(screen.getByRole('link', { name: '写评测' }));
    expect(await screen.findByRole('radio', { name: '写评测' })).toBeChecked();
    expect(screen.getByLabelText('标题')).toHaveValue('写了一半');

    fillAndPublish();
    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/posts')[0].body).toMatchObject({ kind: 'review' }));
  });

  it('手动选择单选框生效，非法类型回落到爆料', async () => {
    const created = makePost('new1');
    const fetchMock = stubApi({ 'POST /api/posts': created, 'GET /api/posts/new1': created });
    renderApp('/submit?kind=foo');
    expect(screen.getByRole('radio', { name: '发爆料' })).toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: '写指南' }));
    expect(await screen.findByRole('radio', { name: '写指南' })).toBeChecked();

    fillAndPublish();
    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/posts')[0].body).toMatchObject({ kind: 'guide' }));
  });
});

describe('评论去重', () => {
  const author = { handle: 'demo-pedal', nickname: '虚构踏板', avatar: '' };
  const comment = (id: string, content: string, replies: unknown[] = []) => ({
    id, targetType: 'post', targetId: 'p1', author, content, parentId: null, createdAt: '2026-11-03T08:00:00.000Z', replies,
  });
  const contents = (text: string) => screen.queryAllByText(text, { selector: '.comment-content' });
  const publish = async (text: string) => {
    fireEvent.change(screen.getByLabelText('写评论'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: '发表评论' }));
    await waitFor(() => expect(contents(text)).toHaveLength(1));
  };

  it('发表后加载更多因分页偏移拿到重复项时只显示一次，本地回复不重复', async () => {
    const reply = { id: 'r1', targetType: 'post', targetId: 'p1', author, content: '本地回复', parentId: 'c1', createdAt: '2026-11-03T08:00:00.000Z' };
    stubApi({
      'GET /api/posts/p1': makePost('p1'),
      'GET /api/comments': ({ url }: StubRequest) => (url.searchParams.get('page') === '1'
        ? page([comment('c1', '第一页末条')], 3)
        : page([comment('c1', '第一页末条', [reply]), comment('c2', '第二页')], 3, 2)),
      'POST /api/comments': ({ body }: StubRequest) => ((body as { parentId?: string }).parentId ? reply : comment('c0', '新评论')),
    });
    renderApp('/posts/p1');
    await screen.findByText('第一页末条', { selector: '.comment-content' });
    await publish('新评论');

    fireEvent.click(screen.getAllByRole('button', { name: '回复' }).at(-1)!);
    fireEvent.change(screen.getByLabelText(/^回复 /), { target: { value: '本地回复' } });
    fireEvent.click(screen.getByRole('button', { name: '发表回复' }));
    await waitFor(() => expect(contents('本地回复')).toHaveLength(1));

    const errorLog = vi.spyOn(console, 'error');
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await screen.findByText('第二页', { selector: '.comment-content' });
    expect(contents('第一页末条')).toHaveLength(1);
    expect(contents('本地回复')).toHaveLength(1);
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('首屏失败后发表再重试，新评论只显示一次', async () => {
    let attempts = 0;
    stubApi({
      'GET /api/posts/p1': makePost('p1'),
      'GET /api/comments': () => (++attempts === 1 ? apiError(500, 'INTERNAL', '评论服务异常') : page([comment('c0', '新评论')])),
      'POST /api/comments': comment('c0', '新评论'),
    });
    renderApp('/posts/p1');
    await screen.findByText('评论服务异常');
    fireEvent.change(screen.getByLabelText('写评论'), { target: { value: '新评论' } });
    fireEvent.click(screen.getByRole('button', { name: '发表评论' }));
    await waitFor(() => expect(screen.getByLabelText('写评论')).toHaveValue(''));

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(contents('新评论').length).toBeGreaterThan(0));
    expect(contents('新评论')).toHaveLength(1);
  });
});

describe('操作成功后刷新当前用户', () => {
  const favorites = page([{
    userHandle: 'demo-pedal', targetType: 'post', targetId: 'p1', createdAt: '2026-11-03T08:00:00.000Z', post: makePost('p1'),
  }]);

  it('收藏成功后 /me 收藏数更新，刷新期间不闪回骨架屏', async () => {
    const refreshed = deferred<Response>();
    let reads = 0;
    stubApi({
      'GET /api/me': () => (++reads === 1 ? me : refreshed.promise),
      'GET /api/me/favorites': favorites,
      'PUT /api/favorites': { targetType: 'post', targetId: 'p1', favorited: true, favoriteCount: 8 },
    });
    renderApp('/me');
    const favorite = await screen.findByRole('button', { name: '收藏' });
    expect(within(stat('收藏')).getByText('2')).toBeInTheDocument();

    fireEvent.click(favorite);
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByRole('heading', { name: '虚构踏板' })).toBeInTheDocument();
    expect(favorite).toBeInTheDocument();

    await act(async () => {
      refreshed.resolve(json({ ...me, favoriteCount: 3 }));
      await refreshed.promise;
    });
    await waitFor(() => expect(within(stat('收藏')).getByText('3')).toBeInTheDocument());
    expect(favorite).toBeInTheDocument();
  });

  it('刷新失败时保留已有数据并提示，收藏结果不回滚', async () => {
    let reads = 0;
    stubApi({
      'GET /api/me': () => (++reads === 1 ? me : apiError(500, 'INTERNAL', '用户服务异常')),
      'GET /api/me/favorites': favorites,
      'PUT /api/favorites': { targetType: 'post', targetId: 'p1', favorited: true, favoriteCount: 8 },
    });
    renderApp('/me');
    fireEvent.click(await screen.findByRole('button', { name: '收藏' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('用户服务异常');
    expect(within(stat('收藏')).getByText('2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收藏' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('投稿成功后 /me 分享数更新', async () => {
    const created = makePost('new1');
    let published = false;
    stubApi({
      'GET /api/me': () => ({ ...me, shareCount: published ? 2 : 1 }),
      'POST /api/posts': () => { published = true; return created; },
      'GET /api/posts/new1': created,
    });
    renderApp('/submit');
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '标题' } });
    fireEvent.change(screen.getByLabelText('摘要'), { target: { value: '摘要' } });
    fireEvent.change(screen.getByLabelText(/^正文/), { target: { value: '正文' } });
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));
    await waitFor(() => expect(within(stat('分享')).getByText('2')).toBeInTheDocument());
  });
});

describe('日期按 Asia/Shanghai 显示', () => {
  it('formatDate 在上海零点切换日期', () => {
    expect(formatDate('2026-11-03T15:59:59.999Z')).toBe('2026-11-03');
    expect(formatDate('2026-11-03T16:00:00.000Z')).toBe('2026-11-04');
    expect(formatDate('2026-12-31T16:00:00.000Z')).toBe('2027-01-01');
  });

  it('PostCard 显示上海日期的月-日', async () => {
    stubApi();
    renderWithProviders(<PostCard post={makePost('p1', { publishedAt: '2026-12-31T16:00:00.000Z' })} />);
    expect(await screen.findByText('01-01')).toBeInTheDocument();
  });
});

describe('签到失败回到一致状态', () => {
  let rejections: unknown[];
  const record = (reason: unknown) => { rejections.push(reason); };
  beforeEach(() => {
    rejections = [];
    process.on('unhandledRejection', record);
  });
  afterEach(() => { process.off('unhandledRejection', record); });

  it('409 后同步用户失败：回滚乐观更新并提示，无未处理 rejection', async () => {
    let reads = 0;
    stubApi({
      'GET /api/me': () => (++reads === 1 ? me : apiError(500, 'INTERNAL', '用户服务异常')),
      'POST /api/me/checkin': () => apiError(409, 'ALREADY_CHECKED_IN', '今天已经签到过了'),
    });
    renderWithProviders(<UserCard />);

    fireEvent.click(await screen.findByRole('button', { name: '签到领Token' }));
    expect(await screen.findByRole('button', { name: '签到领Token' })).toBeEnabled();
    await screen.findByText('用户服务异常');
    expect(screen.getByText('今天已经签到过了')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve));
    expect(rejections).toEqual([]);
  });
});

describe('中转站列表', () => {
  const sortOf = (req: StubRequest) => req.url.searchParams.get('sort');
  const stations = (rows: Record<string, (req: StubRequest, pageNo: number) => unknown>) => ({
    'GET /api/stations': (req: StubRequest) => {
      if (req.url.searchParams.get('pageSize') === '50') return page([station]);
      const pageNo = Number(req.url.searchParams.get('page'));
      return pageNo === 1 ? page([station], 2) : rows[sortOf(req)!](req, pageNo);
    },
  });

  it('筛选变化后不显示旧列表的加载错误，新列表自身的错误照常显示', async () => {
    stubApi(stations({
      score: () => apiError(500, 'INTERNAL', '旧列表失败'),
      rate: () => apiError(500, 'INTERNAL', '新列表失败'),
    }));
    renderApp('/stations');
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('旧列表失败')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '倍率' }));
    const more = await screen.findByRole('button', { name: '加载更多' });
    expect(screen.queryByText('旧列表失败')).not.toBeInTheDocument();

    fireEvent.click(more);
    expect(await screen.findByText('新列表失败')).toBeInTheDocument();
  });

  it('筛选变化后才返回的旧请求错误不落到新列表', async () => {
    const stale = deferred<Response>();
    stubApi(stations({ score: () => stale.promise, rate: () => page([], 2, 2) }));
    renderApp('/stations');
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    fireEvent.click(screen.getByRole('button', { name: '倍率' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '倍率' })).toHaveAttribute('aria-pressed', 'true'));
    await screen.findByText('云栈');

    await act(async () => {
      stale.resolve(apiError(500, 'INTERNAL', '旧列表失败'));
      await stale.promise;
    });
    await screen.findByRole('button', { name: '加载更多' });
    expect(screen.queryByText('旧列表失败')).not.toBeInTheDocument();
  });

  it('非法 sort 回落到综合，不把非法值发给后端', async () => {
    const fetchMock = stubApi({
      'GET /api/stations': (req: StubRequest) => {
        const sort = sortOf(req);
        return sort && !['score', 'rate', 'uptime'].includes(sort) ? apiError(400, 'VALIDATION', 'sort 非法') : page([station]);
      },
    });
    renderApp('/stations?sort=foo');
    expect(await screen.findByRole('heading', { name: '云栈' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '综合' })).toHaveAttribute('aria-pressed', 'true');
    expect(callsTo(fetchMock, 'GET', '/api/stations').map(({ url }) => url.searchParams.get('sort'))).not.toContain('foo');
  });
});
