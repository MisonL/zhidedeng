import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { Providers } from '../src/state';
import type { StationDetail } from '@zhidedeng/shared';
import { describe, expect, it } from 'vitest';
import Comments from '../src/components/Comments';
import Markdown from '../src/components/Markdown';
import { makePost, page, station, vendors } from './fixtures';
import { apiError, callsTo, renderApp, renderWithProviders, stubApi } from './helpers';
import { me } from './fixtures';

// 演示来源现在有统一的来源标签（sourceLabel 的 demo 分支），
// 站点详情里那句提示是「标签 + 不构成消费建议」，不再走单独的兜底常量。
const DEMO_NOTICE = '演示数据';

describe('数据诚信声明', () => {
  it('全站页脚常驻，站点详情顶部也显示', async () => {
    const detail: StationDetail = {
      ...station,
      offers: [{ stationSlug: 'yunzhan', modelSlug: 'deepseek-v4', rate: 0.6, basis: 'blended', quotedAt: null, model: vendors[0].models[0] }],
    };
    stubApi({ 'GET /api/stations/yunzhan': detail });
    renderApp('/stations/yunzhan');

    expect(within(screen.getByRole('contentinfo')).getByText(/不构成消费建议/)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '云栈' })).toBeInTheDocument();
    // 页脚声明里也有「演示数据」四个字，所以按 note 角色定位顶部那条提示。
    expect(await within(screen.getByRole('main')).findByRole('note')).toHaveTextContent(DEMO_NOTICE);
    expect(screen.getByText('0.6x')).toBeInTheDocument();
  });

  it('报价标明计价口径与来源时间，来源没说不写成「刚刚」', async () => {
    // rate 只说「相对官方价多少」。不标口径的话，按输入 0.3 和综合 0.5
    // 会并排放着，读者以为能直接比大小——而它们说的不是一回事。
    const detail: StationDetail = {
      ...station,
      offers: [
        { stationSlug: 'yunzhan', modelSlug: 'deepseek-v4', rate: 0.3, basis: 'input', quotedAt: null, model: vendors[0].models[0] },
        { stationSlug: 'yunzhan', modelSlug: 'gpt-5', rate: 0.5, basis: 'blended', quotedAt: '2026-11-01T00:00:00.000Z', model: vendors[1].models[0] },
      ],
    };
    stubApi({ 'GET /api/stations/yunzhan': detail });
    renderApp('/stations/yunzhan');
    expect(await screen.findByText('按输入')).toBeInTheDocument();
    expect(screen.getByText('综合')).toBeInTheDocument();
    // null 表示来源没说，不能显示成「刚刚」或今天
    expect(screen.getByText('时间未知')).toBeInTheDocument();
    expect(screen.getByText('2026-11-01')).toBeInTheDocument();
  });

  it('老库里没有口径字段按综合读，认不出的口径显示未知而不是默默当综合', async () => {
    // 老库的 offers 只有三列，补列后是 blended；但 ALTER 补不上 CHECK，
    // 历史脏值（比如手工 UPDATE 进去的）确实可能存在。这时不能替它编一个口径。
    const detail = {
      ...station,
      offers: [
        { stationSlug: 'yunzhan', modelSlug: 'deepseek-v4', rate: 0.4, model: vendors[0].models[0] },
        { stationSlug: 'yunzhan', modelSlug: 'gpt-5', rate: 0.5, basis: 'garbage', quotedAt: null, model: vendors[1].models[0] },
      ],
    } as unknown as StationDetail;
    stubApi({ 'GET /api/stations/yunzhan': detail });
    renderApp('/stations/yunzhan');
    expect(await screen.findByText('综合')).toBeInTheDocument();
    expect(screen.getByText('未知口径')).toBeInTheDocument();
    expect(screen.queryByText('按输入')).toBeNull();
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
    await waitFor(() => expect(callsTo(fetchMock, 'PATCH', '/api/me')[0].body).toEqual({ nickname: '新昵称', bio: '蹬得开心', avatar: '' }));
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
  it('页脚声明点名 AI 采集，不能只提演示数据和群友提交', async () => {
    // 页脚是读者判断「这条内容能不能信」的唯一全局提示。
    // 少写 agent 一类时，AI 写入的内容会被读者归进「演示数据」或「群友提交」，
    // 而它两者都不是。
    stubApi({});
    renderApp('/');
    const notice = await screen.findByText(/未经平台核实/);
    expect(notice.textContent).toContain('AI 采集');
    expect(notice.textContent).toContain('群友提交');
    expect(notice.textContent).toContain('演示数据');
  });

});

describe('投稿后的落点', () => {
  it('补录模型后落到「我的投稿」，那里才有这条记录', async () => {
    // 原来跳 /me?tab=posts（我的分享），而模型补录的结果在「我的投稿」里。
    // 用户会落到「还没有分享」并以为提交失败，然后重复投一遍。
    stubApi({
      'POST /api/models/suggest': { id: 'sub-1', slug: 'claude-x', status: 'pending', deduplicated: false },
      'GET /api/me/submissions': page([]),
    });
    renderApp('/submit?kind=model');
    // 厂商下拉的选项来自目录接口。目录没回来时 <select> 里没有这一项，
    // 设值会被浏览器归一成空串（HTMLSelectElement.value 对不存在的 option 返回 ''），
    // 于是提交被自己的必填校验挡住——这条等待不是装饰。
    await screen.findByRole('option', { name: 'OpenAI' });
    fireEvent.change(screen.getByLabelText('模型 slug'), { target: { value: 'claude-x' } });
    fireEvent.change(screen.getByLabelText('厂商'), { target: { value: 'openai' } });
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'Claude X' } });
    fireEvent.change(screen.getByLabelText('一句话说明'), { target: { value: '说明' } });
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));

    expect(await screen.findByRole('tab', { name: '我的投稿' })).toHaveAttribute('aria-selected', 'true');
  });

  it('推荐中转站后也落到「我的投稿」，不落到「我的分享」', async () => {
    stubApi({
      'POST /api/stations/suggest': { slug: 'new-station', status: 'pending', deduplicated: false, submissionId: 'sub-2' },
      'GET /api/me/submissions': page([]),
    });
    renderApp('/submit?kind=station');
    fireEvent.change(screen.getByLabelText('站点名称'), { target: { value: '新中转站' } });
    fireEvent.change(screen.getByLabelText('网址'), { target: { value: 'https://new.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));

    expect(await screen.findByRole('tab', { name: '我的投稿' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('评论自删', () => {
  it('只有自己的评论才显示删除按钮', async () => {
    // 当前登录用户是 fixtures 里的 me（handle: demo-pedal）。
    const mine = { handle: 'demo-pedal', nickname: '我自己', avatar: '' };
    const other = { handle: 'someone', nickname: '别人', avatar: '' };
    stubApi({
      'GET /api/comments': page([
        { id: 'c-mine', targetType: 'post', targetId: 'p1', author: mine, content: '我的评论', parentId: null, createdAt: '2026-11-03T08:00:00.000Z', replies: [] },
        { id: 'c-other', targetType: 'post', targetId: 'p1', author: other, content: '别人的评论', parentId: null, createdAt: '2026-11-03T09:00:00.000Z', replies: [] },
      ]),
    });
    renderWithProviders(<Comments targetType="post" targetId="p1" />);
    expect(await screen.findByText('我的评论')).toBeInTheDocument();
    // 两条「回复」都在，但「删除」只有一个。
    expect(screen.getAllByRole('button', { name: '回复' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(1);
  });

  it('删除要先确认，确认后调用接口并从列表移除', async () => {
    // 当前登录用户是 fixtures 里的 me（handle: demo-pedal）。
    const mine = { handle: 'demo-pedal', nickname: '我自己', avatar: '' };
    const fetchMock = stubApi({
      'GET /api/comments': page([
        { id: 'c-mine', targetType: 'post', targetId: 'p1', author: mine, content: '要被删掉的话', parentId: null, createdAt: '2026-11-03T08:00:00.000Z', replies: [] },
      ]),
      'DELETE /api/comments/c-mine': { id: 'c-mine', deleted: 'removed' },
    });
    renderWithProviders(<Comments targetType="post" targetId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    // 只点一次不会发请求：必须再点「删除」确认。
    expect(callsTo(fetchMock, 'DELETE', '/api/comments/c-mine')).toHaveLength(0);
    expect(screen.getByText(/删除后无法恢复/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(callsTo(fetchMock, 'DELETE', '/api/comments/c-mine')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('要被删掉的话')).not.toBeInTheDocument());
  });

  it('墓碑渲染成「该评论已删除」，其下的回复保留', async () => {
    stubApi({
      'GET /api/comments': page([
        {
          id: 'c-tomb', targetType: 'post', targetId: 'p1', author: { handle: 'demo-pedal', nickname: '我自己', avatar: '' },
          content: '', deleted: true, parentId: null, createdAt: '2026-11-03T08:00:00.000Z',
          replies: [{ id: 'r1', targetType: 'post', targetId: 'p1', author: { handle: 'x', nickname: '路人', avatar: '' }, content: '别人写的话', parentId: 'c-tomb', createdAt: '2026-11-03T09:00:00.000Z' }],
        },
      ]),
    });
    renderWithProviders(<Comments targetType="post" targetId="p1" />);
    expect(await screen.findByText('该评论已删除')).toBeInTheDocument();
    // 别人的回复不跟着消失，也不该出现「回复」入口（墓碑不能再被回复）。
    expect(screen.getByText('别人写的话')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '回复' })).not.toBeInTheDocument();
  });
});

describe('撤下自己的文章', () => {
  it('已发布的文章才有撤下入口，确认后调用接口并显示已撤下', async () => {
    const published = makePost('mine-1', { title: '我写的那篇', status: 'approved' });
    const pending = makePost('mine-2', { title: '还在审的', status: 'pending' });
    const fetchMock = stubApi({
      'GET /api/me/posts': page([published, pending]),
      'DELETE /api/posts/mine-1': { id: 'mine-1', removed: true },
    });
    renderApp('/me?tab=posts');

    expect(await screen.findByText('我写的那篇')).toBeInTheDocument();
    // 待审的那篇没有撤下入口：它还没上线。
    expect(screen.getAllByRole('button', { name: '撤下这篇文章' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '撤下这篇文章' }));
    expect(callsTo(fetchMock, 'DELETE', '/api/posts/mine-1')).toHaveLength(0);
    expect(screen.getByText(/撤下后其他人立刻看不到/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '撤下' }));

    await waitFor(() => expect(callsTo(fetchMock, 'DELETE', '/api/posts/mine-1')).toHaveLength(1));
    expect(await screen.findByText(/已撤下。需要恢复请站内联系管理员/)).toBeInTheDocument();
  });

  it('撤下后页头的「分享」数字跟着更新，不会和列表自相矛盾', async () => {
    // 实测见过：列表已经空了，页头还写着「分享 1」。它读的是 /api/me，
    // 不刷新就停在撤之前的数字。
    let shareCount = 1;
    const published = makePost('mine-1', { title: '我写的那篇', status: 'approved' });
    const fetchMock = stubApi({
      'GET /api/me/posts': page([published]),
      'GET /api/me': () => ({ ...me, shareCount }),
      'DELETE /api/posts/mine-1': () => { shareCount = 0; return { id: 'mine-1', removed: true }; },
    });
    renderApp('/me?tab=posts');
    expect(await screen.findByText('我写的那篇')).toBeInTheDocument();
    // 只读「分享」那一格的数字：整个 .me-stats 里还有 Token 1280，用包含判断会被它骗过。
    const shareCell = () => {
      const cell = [...document.querySelectorAll('.me-stats div')].find(node => node.querySelector('dt')?.textContent === '分享');
      return cell?.querySelector('dd')?.textContent ?? '';
    };
    expect(shareCell()).toBe('1');

    fireEvent.click(screen.getByRole('button', { name: '撤下这篇文章' }));
    fireEvent.click(screen.getByRole('button', { name: '撤下' }));
    await screen.findByText(/已撤下。需要恢复请站内联系管理员/);

    // 撤下后必须重新取 /api/me，页头才会变成 0。
    await waitFor(() => expect(callsTo(fetchMock, 'GET', '/api/me').length).toBeGreaterThan(1));
    await waitFor(() => expect(shareCell()).toBe('0'));
  });
});

describe('预设头像', () => {
  it('设置页能选预设头像并保存，保存内容包含所选 preset', async () => {
    const fetchMock = stubApi({
      'PATCH /api/me': (input: { body: { nickname: string; bio: string; avatar: string } }) => ({
        handle: 'demo-pedal', tokens: 1280, checkedInToday: false, streak: 3, favoriteCount: 2, shareCount: 1, ...input.body,
      }),
    });
    renderApp('/me?tab=settings');
    // 当前是默认（空），选中 🦊 后保存。
    // 按钮的可访问名现在是中文动物名（图案本身 aria-hidden），不是重复的 emoji。
    fireEvent.click(await screen.findByRole('button', { name: /狐狸/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(callsTo(fetchMock, 'PATCH', '/api/me')[0].body).toMatchObject({ avatar: '🦊' }));
    expect(await screen.findByText('已保存')).toBeInTheDocument();
  });
});

describe('删除与头像的回归（审查修复）', () => {
  it('删回复会真的从列表消失，而不是只请求成功', async () => {
    const mine = { handle: 'demo-pedal', nickname: '我自己', avatar: '' };
    const fetchMock = stubApi({
      'GET /api/comments': page([{
        id: 'c1', targetType: 'post', targetId: 'p1', author: mine, content: '父评论',
        parentId: null, createdAt: '2026-11-03T08:00:00.000Z',
        replies: [{ id: 'r1', targetType: 'post', targetId: 'p1', author: mine, content: '我的回复', parentId: 'c1', createdAt: '2026-11-03T09:00:00.000Z' }],
      }]),
      'DELETE /api/comments/r1': { id: 'r1', deleted: 'removed' },
    });
    renderWithProviders(<Comments targetType="post" targetId="p1" />);
    expect(await screen.findByText('我的回复')).toBeInTheDocument();
    // 父评论与回复各有一个「删除」，回复的是第二个。
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[1]);
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(callsTo(fetchMock, 'DELETE', '/api/comments/r1')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('我的回复')).not.toBeInTheDocument());
    // 父评论还在。
    expect(screen.getByText('父评论')).toBeInTheDocument();
  });

  it('删除失败时说清原因，而不是静默当作删掉了', async () => {
    const mine = { handle: 'demo-pedal', nickname: '我自己', avatar: '' };
    stubApi({
      'GET /api/comments': page([{
        id: 'c1', targetType: 'post', targetId: 'p1', author: mine, content: '删不掉的评论',
        parentId: null, createdAt: '2026-11-03T08:00:00.000Z', replies: [],
      }]),
      'DELETE /api/comments/c1': apiError(404, 'NOT_FOUND', '评论不存在'),
    });
    renderWithProviders(<Comments targetType="post" targetId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('评论不存在');
    // 失败的评论不能从列表消失（否则用户以为删掉了，刷新又回来）。
    expect(screen.getByText('删不掉的评论')).toBeInTheDocument();
  });

  it('切到另一篇文章时不带着上一页的本地状态', async () => {
    const mine = { handle: 'demo-pedal', nickname: '我自己', avatar: '' };
    stubApi({
      'GET /api/comments': ({ url }: { url: URL }) => page(url.searchParams.get('targetId') === 'p1'
        ? [{ id: 'c1', targetType: 'post', targetId: 'p1', author: mine, content: 'p1 的评论', parentId: null, createdAt: '2026-11-03T08:00:00.000Z', replies: [] }]
        : [{ id: 'c2', targetType: 'post', targetId: 'p2', author: mine, content: 'p2 的评论', parentId: null, createdAt: '2026-11-03T09:00:00.000Z', replies: [] }]),
      'POST /api/comments': { id: 'local-new', targetType: 'post', targetId: 'p1', author: mine, content: 'p1 新写的', parentId: null, createdAt: '2026-11-03T10:00:00.000Z', replies: [] },
    });
    // 真实路由里换文章时，PostDetail/Comments **不会卸载**，只是 props 变了
    // （同一个 route 元素，id 参数不同）。所以这里必须保住同一个 Router 实例，
    // 用组件内部状态切换 targetId，才测得到「没重置」这个 bug。
    function Harness() {
      const [target, setTarget] = useState('p1');
      return (
        <>
          <button type="button" onClick={() => setTarget('p2')}>换一篇</button>
          <Comments targetType="post" targetId={target} />
        </>
      );
    }
    renderWithProviders(<Harness />);
    expect(await screen.findByText('p1 的评论')).toBeInTheDocument();
    // 在 p1 发一条评论（本地 added 列表），它不属于 p2。
    fireEvent.change(screen.getByLabelText('写评论'), { target: { value: 'p1 新写的' } });
    fireEvent.click(screen.getByRole('button', { name: '发表评论' }));
    expect(await screen.findByText('p1 新写的')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '换一篇' }));
    expect(await screen.findByText('p2 的评论')).toBeInTheDocument();
    // 本地新增的评论不能跟着串到另一篇下面。
    expect(screen.queryByText('p1 新写的')).not.toBeInTheDocument();
  });

  it('删回复不触发重取：回复不影响顶层 total，重取只会丢掉已展开的后续页', async () => {
    const mine = { handle: 'demo-pedal', nickname: '我自己', avatar: '' };
    const fetchMock = stubApi({
      'GET /api/comments': { items: [{
        id: 'c1', targetType: 'post', targetId: 'p1', author: mine, content: '父评论',
        parentId: null, createdAt: '2026-11-03T08:00:00.000Z',
        replies: [{ id: 'r1', targetType: 'post', targetId: 'p1', author: mine, content: '我的回复', parentId: 'c1', createdAt: '2026-11-03T09:00:00.000Z' }],
      }], total: 25, page: 1, pageSize: 20 },
      'DELETE /api/comments/r1': { id: 'r1', deleted: 'removed' },
    });
    renderWithProviders(<Comments targetType="post" targetId="p1" />);
    await screen.findByText('我的回复');
    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[1]);
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(callsTo(fetchMock, 'DELETE', '/api/comments/r1')).toHaveLength(1));
    expect(screen.queryByText('我的回复')).not.toBeInTheDocument();
    // 只有首屏那一次 GET。
    expect(callsTo(fetchMock, 'GET', '/api/comments')).toHaveLength(1);
  });

  it('还有后续页时，物理删一条会重取，避免「加载更多」漏掉补位的那条', async () => {
    const mine = { handle: 'demo-pedal', nickname: '我自己', avatar: '' };
    const fetchMock = stubApi({
      // total 25 但第一页只给 1 条 → hasMore 为 true。
      'GET /api/comments': { items: [{ id: 'c1', targetType: 'post', targetId: 'p1', author: mine, content: '会被删的', parentId: null, createdAt: '2026-11-03T08:00:00.000Z', replies: [] }], total: 25, page: 1, pageSize: 20 },
      'DELETE /api/comments/c1': { id: 'c1', deleted: 'removed' },
    });
    renderWithProviders(<Comments targetType="post" targetId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(callsTo(fetchMock, 'GET', '/api/comments')).toHaveLength(2));
  });

  it('头像设置后真的渲染出预设图案，而不只是存了个字段', async () => {
    const withAvatar = { ...me, avatar: '🦊' };
    stubApi({ 'GET /api/me': withAvatar });
    renderApp('/me?tab=settings');
    // 个人中心页头的头像（Avatar 组件）必须画出预设图案。只看「页面上出现过 🦊」
    // 会被选择器里的选项按钮骗过——那些 emoji 是候选，不是当前头像。
    await screen.findByRole('heading', { name: me.nickname });
    const avatar = document.querySelector('.avatar-preset-fill');
    expect(avatar?.textContent).toBe('🦊');
  });
});

describe('删掉最后一条评论', () => {
  it('列表回到空态，而不是留一片空白', async () => {
    const mine = { handle: 'demo-pedal', nickname: '我自己', avatar: '' };
    stubApi({
      'GET /api/comments': page([{
        id: 'only', targetType: 'post', targetId: 'p1', author: mine, content: '唯一的一条',
        parentId: null, createdAt: '2026-11-03T08:00:00.000Z', replies: [],
      }]),
      'DELETE /api/comments/only': { id: 'only', deleted: 'removed' },
    });
    renderWithProviders(<Comments targetType="post" targetId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
    expect(await screen.findByText('还没有评论，来抢沙发')).toBeInTheDocument();
  });
});

describe('切页期间的写请求', () => {
  it('晚到的发表响应不会贴到新目标下面', async () => {
    const mine = { handle: 'demo-pedal', nickname: '我自己', avatar: '' };
    // 让发表请求挂住，切到 p2 之后再放行。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stubApi({
      'GET /api/comments': ({ url }: { url: URL }) => page(url.searchParams.get('targetId') === 'p1'
        ? [{ id: 'c1', targetType: 'post', targetId: 'p1', author: mine, content: 'p1 的评论', parentId: null, createdAt: '2026-11-03T08:00:00.000Z', replies: [] }]
        : [{ id: 'c2', targetType: 'post', targetId: 'p2', author: mine, content: 'p2 的评论', parentId: null, createdAt: '2026-11-03T09:00:00.000Z', replies: [] }]),
      'POST /api/comments': async () => {
        await gate;
        return { id: 'late', targetType: 'post', targetId: 'p1', author: mine, content: 'p1 晚到的评论', parentId: null, createdAt: '2026-11-03T10:00:00.000Z', replies: [] };
      },
    });
    function Harness() {
      const [target, setTarget] = useState('p1');
      return (
        <>
          <button type="button" onClick={() => setTarget('p2')}>换一篇</button>
          <Comments targetType="post" targetId={target} />
        </>
      );
    }
    renderWithProviders(<Harness />);
    await screen.findByText('p1 的评论');
    fireEvent.change(screen.getByLabelText('写评论'), { target: { value: 'p1 晚到的评论' } });
    fireEvent.click(screen.getByRole('button', { name: '发表评论' }));
    // 请求还没回来就切页。
    fireEvent.click(screen.getByRole('button', { name: '换一篇' }));
    await screen.findByText('p2 的评论');
    // 在新页面上重新打字，模拟用户切页后继续写。
    const box = screen.getByLabelText('写评论') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'p2 的新草稿' } });
    release();
    // 晚到的响应属于 p1，不能出现在 p2 的列表里，也不能清掉 p2 刚打的草稿。
    await waitFor(() => expect(screen.queryByText('p1 晚到的评论')).not.toBeInTheDocument());
    expect(screen.getByText('p2 的评论')).toBeInTheDocument();
    await waitFor(() => expect((screen.getByLabelText('写评论') as HTMLTextAreaElement).value).toBe('p2 的新草稿'));
  });
});
