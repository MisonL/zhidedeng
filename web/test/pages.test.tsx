import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { StationDetail } from '@zhidedeng/shared';
import { describe, expect, it } from 'vitest';
import Markdown from '../src/components/Markdown';
import { makePost, page, station, vendors } from './fixtures';
import { apiError, callsTo, renderApp, renderWithProviders, stubApi } from './helpers';

const DISCLAIMER = '当前为演示数据，不构成消费建议';

describe('数据诚信声明', () => {
  it('全站页脚常驻，站点详情顶部也显示', async () => {
    const detail: StationDetail = {
      ...station,
      offers: [{ stationSlug: 'yunzhan', modelSlug: 'deepseek-v4', rate: 0.6, model: vendors[0].models[0] }],
    };
    stubApi({ 'GET /api/stations/yunzhan': detail });
    renderApp('/stations/yunzhan');

    expect(within(screen.getByRole('contentinfo')).getByText(/不构成消费建议/)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '云栈' })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByText(new RegExp(DISCLAIMER))).toBeInTheDocument();
    expect(screen.getByText('0.6x')).toBeInTheDocument();
  });
});

describe('Markdown 防 XSS', () => {
  it('不渲染 raw HTML，剥离危险链接', () => {
    const { container } = renderWithProviders(
      <Markdown>{'<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[坏链接](javascript:alert(1))\n\n**粗体**'}</Markdown>,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('坏链接').getAttribute('href') ?? '').not.toContain('javascript');
    expect(screen.getByText('粗体').tagName).toBe('STRONG');
  });
});

describe('首页信息流', () => {
  it('卡片展示站点倍率、标签、比例条，可筛选和加载更多', async () => {
    const fetchMock = stubApi({
      'GET /api/posts': ({ url }: { url: URL }) => {
        if (url.searchParams.get('pageSize') === '6') return page([makePost('hot1', { title: '热门文章一' })]);
        const pageNo = Number(url.searchParams.get('page'));
        return page([makePost(`p${pageNo}`)], 2, pageNo);
      },
    });
    renderApp('/');

    expect(await screen.findByRole('heading', { name: '爆料 p1' })).toBeInTheDocument();
    expect((await screen.findAllByText('云栈 低至 0.6x'))[0]).toBeInTheDocument();
    expect(screen.getAllByText('可用率 99.2%')[0]).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /去看看/ })[0]).toHaveAttribute('href', '/stations/yunzhan');

    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByRole('heading', { name: '爆料 p2' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '最热' }));
    await waitFor(() => {
      const last = callsTo(fetchMock, 'GET', '/api/posts').at(-1)!.url.searchParams;
      expect(last.get('sort')).toBe('hot');
      expect(last.get('page')).toBe('1');
    });
  });

  it('错误与空态', async () => {
    let attempts = 0;
    stubApi({
      'GET /api/posts': ({ url }: { url: URL }) => {
        if (url.searchParams.get('pageSize') === '6') return page([makePost('hot')]);
        return ++attempts === 1 ? apiError(500, 'INTERNAL', '信息流异常') : page([]);
      },
    });
    renderApp('/');
    expect(await screen.findByText('信息流异常')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('这里还没有内容')).toBeInTheDocument();
  });
});

describe('投稿', () => {
  it('按 URL 预选类型，提交后跳到我的分享', async () => {
    const created = makePost('new1', { kind: 'review', title: '我的新评测', body: '**详情**' });
    const fetchMock = stubApi({ 'POST /api/posts': created, 'GET /api/me/posts': page([created]) });
    renderApp('/submit?kind=review');

    expect(screen.getByRole('radio', { name: '写评测' })).toBeChecked();
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '我的新评测' } });
    fireEvent.change(screen.getByLabelText('摘要'), { target: { value: '一句话' } });
    fireEvent.change(screen.getByLabelText(/^正文/), { target: { value: '**详情**' } });
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));

    expect(await screen.findByRole('tab', { name: '我的分享' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('link', { name: '我的新评测' })).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/posts')[0].body).toEqual({
      kind: 'review', title: '我的新评测', summary: '一句话', body: '**详情**',
    });
  });

  it('必填缺失时不提交，服务端错误显示在表单内', async () => {
    const fetchMock = stubApi({ 'POST /api/posts': () => apiError(400, 'VALIDATION', '标题太短') });
    renderApp('/submit');
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));
    expect(await screen.findByText('请填写标题')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/posts')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('摘要'), { target: { value: 'b' } });
    fireEvent.change(screen.getByLabelText(/^正文/), { target: { value: 'c' } });
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));
    expect(await screen.findByText('标题太短')).toBeInTheDocument();
  });
});

describe('评论', () => {
  it('发表评论与回复', async () => {
    const author = { handle: 'demo-pedal', nickname: '虚构踏板', avatar: '' };
    const top = {
      id: 'c1', targetType: 'post', targetId: 'p1', author, content: '第一条评论', parentId: null,
      createdAt: '2026-11-03T08:00:00.000Z', replies: [],
    };
    const fetchMock = stubApi({
      'GET /api/posts/p1': makePost('p1'),
      'GET /api/comments': page([top]),
      'POST /api/comments': ({ body }: { body: { content: string; parentId?: string } }) => (body.parentId
        ? { id: 'r1', targetType: 'post', targetId: 'p1', author, content: body.content, parentId: body.parentId, createdAt: top.createdAt }
        : { ...top, id: 'c2', content: body.content }),
    });
    renderApp('/posts/p1');
    expect(await screen.findByText('第一条评论')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('写评论'), { target: { value: '新评论' } });
    fireEvent.click(screen.getByRole('button', { name: '发表评论' }));
    expect(await screen.findByText('新评论', { selector: '.comment-content' })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: '回复' }).at(-1)!);
    fireEvent.change(screen.getByLabelText(/^回复 /), { target: { value: '一层回复' } });
    fireEvent.click(screen.getByRole('button', { name: '发表回复' }));
    expect(await screen.findByText('一层回复', { selector: '.comment-content' })).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/comments').at(-1)?.body).toEqual({ targetType: 'post', targetId: 'p1', content: '一层回复', parentId: 'c1' });
  });
});

describe('我的', () => {
  it('修改昵称写回并同步全站当前用户', async () => {
    const fetchMock = stubApi({
      'PATCH /api/me': ({ body }: { body: { nickname: string; bio: string } }) => ({
        handle: 'demo-pedal', avatar: '', tokens: 1280, checkedInToday: false, streak: 3, favoriteCount: 2, shareCount: 1, ...body,
      }),
    });
    renderApp('/me?tab=settings');

    const nickname = await screen.findByLabelText('昵称');
    fireEvent.change(nickname, { target: { value: '新昵称' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(callsTo(fetchMock, 'PATCH', '/api/me')[0].body).toEqual({ nickname: '新昵称', bio: '蹬得开心' }));
    expect(await within(screen.getByRole('navigation', { name: '主导航' })).findByRole('button', { name: '新昵称' })).toBeInTheDocument();
  });
});

describe('商务合作', () => {
  it('不编造联系方式', () => {
    stubApi();
    renderApp('/business');
    expect(screen.getByText(/联系方式待配置/)).toBeInTheDocument();
  });
});

describe('补录模型', () => {
  // 用 fixtures 里已有的厂商，避免自己编一个对不上真实接口的形状。
  const catalogVendor = vendors[0]!;
  const VENDOR = catalogVendor.slug;

  it('选「补充模型」后显示模型字段，提交走 /api/models/suggest', async () => {
    const fetchMock = stubApi({
      'GET /api/vendors': page(vendors),
      'POST /api/models/suggest': { id: 'm1', slug: 'claude-sonnet-4-5', status: 'pending', deduplicated: false },
    });
    renderApp('/submit?kind=model');

    expect(screen.getByRole('radio', { name: '补充模型' })).toBeChecked();
    // 模型不该显示文章的标题/摘要/正文。
    expect(screen.queryByLabelText('标题')).not.toBeInTheDocument();
    // catalog 未就绪时厂商下拉是空的，此时设 value 会被丢掉——先等选项出现。
    await screen.findByRole('option', { name: catalogVendor.name });

    fireEvent.change(screen.getByLabelText('模型 slug'), { target: { value: 'Claude-Sonnet-4-5' } });
    fireEvent.change(screen.getByLabelText('厂商'), { target: { value: VENDOR } });
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'Claude Sonnet 4.5' } });
    fireEvent.change(screen.getByLabelText('一句话说明'), { target: { value: '一句话' } });
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));

    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/api/models/suggest')).toHaveLength(1));
    // slug 统一转小写，和服务端的 slug 规则一致。
    expect(callsTo(fetchMock, 'POST', '/api/models/suggest')[0].body).toEqual({
      slug: 'claude-sonnet-4-5', vendor: VENDOR, name: 'Claude Sonnet 4.5', description: '一句话',
    });
  });

  it('模型字段不全时不发请求，给出提示', async () => {
    const fetchMock = stubApi({ 'GET /api/vendors': page(vendors) });
    renderApp('/submit?kind=model');
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));
    expect(await screen.findByText('模型需要填写 slug、厂商、名称和说明')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/models/suggest')).toHaveLength(0);
  });

  it('服务端拒绝时显示原因', async () => {
    stubApi({
      'GET /api/vendors': page(vendors),
      'POST /api/models/suggest': () => apiError(409, 'MODEL_EXISTS', '模型已存在'),
    });
    renderApp('/submit?kind=model');
    await screen.findByRole('option', { name: catalogVendor.name });
    fireEvent.change(screen.getByLabelText('模型 slug'), { target: { value: 'dup' } });
    fireEvent.change(screen.getByLabelText('厂商'), { target: { value: VENDOR } });
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: '名称' } });
    fireEvent.change(screen.getByLabelText('一句话说明'), { target: { value: '说明' } });
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));
    expect(await screen.findByText('模型已存在')).toBeInTheDocument();
  });
});
