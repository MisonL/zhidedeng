import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { admin, adminToken } from '../src/admin';
import { apiError, callsTo, renderApp, stubApi } from './helpers';
import type { StubRequest } from './helpers';

const submission = {
  id: 'sub-1', kind: 'station', channel: 'feishu', originKey: 'a.example.com', batchId: 'batch-1',
  action: 'upsert', payload: { name: '示例站', url: 'https://a.example.com/', description: '描述' },
  actorHandle: null, status: 'pending', reason: null,
  createdAt: '2026-11-10T02:00:00.000Z', reviewedAt: null,
};

const post = {
  id: 'post-1', kind: 'review', title: '待审文章标题', summary: '摘要', authorHandle: 'alice',
  stationSlug: null, modelSlug: null, publishedAt: '2026-11-10T03:00:00.000Z', status: 'pending',
};

const removed = { slug: 'gone-example-com', removedAt: '2026-11-10T04:00:00.000Z' };

/** 每个用例都要先输密钥，这里统一封装。 */
async function unlock() {
  renderApp('/admin');
  fireEvent.change(await screen.findByLabelText('管理密钥'), { target: { value: 'x'.repeat(32) } });
  fireEvent.click(screen.getByRole('button', { name: '进入' }));
  await screen.findByRole('heading', { name: '审核台' });
}

beforeEach(() => {
  sessionStorage.clear();
  // 全部通过会先弹二次确认（通过不可撤销），默认点「确定」。
  vi.stubGlobal('confirm', () => true);
});

describe('审核台', () => {
  it('没有密钥时只显示入口，不请求任何管理接口', () => {
    const fetchMock = stubApi({});
    renderApp('/admin');
    expect(screen.getByLabelText('管理密钥')).toBeInTheDocument();
    // 密钥是管理接口的唯一凭据，没填就不该发出请求。
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/admin'))).toBe(false);
  });

  it('填了密钥后用 Bearer 头请求待审投稿，并列出内容摘要', async () => {
    const fetchMock = stubApi({ 'GET /api/admin/submissions': { items: [submission], total: 1 } });
    await unlock();
    expect(await screen.findByText('示例站 · https://a.example.com/')).toBeInTheDocument();
    expect(screen.getByText('飞书')).toBeInTheDocument();
    expect(screen.getByText('a.example.com')).toBeInTheDocument();
    const sent = fetchMock.mock.calls.find(([input]) => String(input).startsWith('/api/admin/submissions'))!;
    expect((sent[1]?.headers as Record<string, string>).authorization).toBe(`Bearer ${'x'.repeat(32)}`);
  });

  it('单条通过会调用审核接口并刷新列表', async () => {
    let items = [submission];
    const fetchMock = stubApi({
      'GET /api/admin/submissions': () => ({ items, total: items.length }),
      'POST /api/admin/submissions/sub-1/review': () => { items = []; return { ...submission, status: 'approved' }; },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('button', { name: '通过' }));
    expect(await screen.findByText('已通过')).toBeInTheDocument();
    const review = callsTo(fetchMock, 'POST', '/api/admin/submissions/sub-1/review');
    expect(review[0].body).toEqual({ status: 'approved' });
    expect(await screen.findByText('没有待审投稿')).toBeInTheDocument();
  });

  it('全部通过把当前列表的 id 一起提交给批量审核', async () => {
    const second = { ...submission, id: 'sub-2', originKey: 'b.example.com', payload: { name: '第二站', url: 'https://b.example.com/' } };
    const fetchMock = stubApi({
      'GET /api/admin/submissions': { items: [submission, second], total: 2 },
      // 真实后端每条一个结果，成功项带 submission、失败项带 error。
      'POST /api/admin/submissions/batch-review': {
        results: [{ id: 'sub-1', submission: { ...submission, status: 'approved' } },
          { id: 'sub-2', submission: { ...second, status: 'approved' } }],
      },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('button', { name: '全部通过' }));
    expect(await screen.findByText('已通过 2 条')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/admin/submissions/batch-review')[0].body)
      .toEqual({ ids: ['sub-1', 'sub-2'], status: 'approved' });
  });

  it('切到文章页签取待审文章，并能通过', async () => {
    const fetchMock = stubApi({
      'GET /api/admin/submissions': { items: [], total: 0 },
      'GET /api/admin/posts': { items: [post] },
      'POST /api/admin/posts/post-1/review': { id: 'post-1', status: 'approved' },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('tab', { name: /待审文章/ }));
    expect(await screen.findByText('待审文章标题')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '通过' }));
    expect(await screen.findByText('已通过')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/admin/posts/post-1/review')[0].body).toEqual({ status: 'approved' });
  });

  it('已下架站点可以一键恢复', async () => {
    const fetchMock = stubApi({
      'GET /api/admin/submissions': { items: [], total: 0 },
      'GET /api/admin/stations/removed': { items: [removed] },
      'POST /api/admin/stations/gone-example-com/restore': { slug: removed.slug, restored: true },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('tab', { name: /已下架站点/ }));
    expect(await screen.findByText('gone-example-com')).toBeInTheDocument();
    // 下架时间是排障信息，必须显示出来。
    expect(screen.getByText(/下架于/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    expect(await screen.findByText('已恢复')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/admin/stations/gone-example-com/restore')).toHaveLength(1);
  });

  it('已下架文章可以一键恢复', async () => {
    // 已发布内容必须能撤回。群友来源的文章原先只能「去飞书撤销通过」，
    // 而那条路走不通——撤销后记录直接不在批次里，生成不了下架请求。
    const withdrawn = { id: 'feishu-rec1', removedAt: '2026-11-10T05:00:00.000Z' };
    const fetchMock = stubApi({
      'GET /api/admin/submissions': { items: [], total: 0 },
      'GET /api/admin/posts/removed': { items: [withdrawn] },
      'POST /api/admin/posts/feishu-rec1/restore': { id: withdrawn.id, restored: true },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('tab', { name: /已下架文章/ }));
    expect(await screen.findByText('feishu-rec1')).toBeInTheDocument();
    // 下架时间是排障信息：要能判断是哪次误操作。
    expect(screen.getByText(/下架于/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    expect(await screen.findByText('已恢复')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/admin/posts/feishu-rec1/restore')).toHaveLength(1);
  });

  it('已上线文章可以下架，下架后跳到「已下架文章」', async () => {
    // 撤回入口只能放在已上线列表：待审的还没物化，实体不存在，
    // 在那里放「下架」点下去只会 404，但作者会以为稿子没了。
    const live = { ...post, id: 'post-1', status: 'approved' as const };
    const fetchMock = stubApi({
      'GET /api/admin/submissions': { items: [], total: 0 },
      'GET /api/admin/posts': { items: [live] },
      'GET /api/admin/posts/removed': { items: [] },
      'POST /api/admin/posts/post-1/withdraw': { id: 'post-1', removed: true },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('tab', { name: /已上线文章/ }));
    expect(await screen.findByText('待审文章标题')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '下架' }));
    expect(await screen.findByText(/已下架，可在/)).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/admin/posts/post-1/withdraw')).toHaveLength(1);
    // 操作完自动切到已下架列表，管理员能立刻确认结果
    expect(await screen.findByText('没有已下架的文章')).toBeInTheDocument();
  });

  it('待审文章列表不提供下架按钮', async () => {
    // 待审稿还没物化。这里给「下架」会渲染成一个必然 404 的按钮，
    // 而作者会以为投稿被删了——撤回只对已上线内容有意义。
    stubApi({
      'GET /api/admin/submissions': { items: [], total: 0 },
      'GET /api/admin/posts': { items: [post] },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('tab', { name: /待审文章/ }));
    expect(await screen.findByText('待审文章标题')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下架' })).toBeNull();
  });

  it('密钥被服务端拒绝时退回入口，不把无效密钥留在会话里', async () => {
    stubApi({ 'GET /api/admin/submissions': () => new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: '密钥无效' } }), { status: 403 }) });
    await unlock();
    expect(await screen.findByLabelText('管理密钥')).toBeInTheDocument();
    expect(sessionStorage.getItem('zdd.adminToken')).toBeNull();
  });

  it('单条操作失败时显示原因，列表保持可见', async () => {
    stubApi({
      'GET /api/admin/submissions': { items: [submission], total: 1 },
      'POST /api/admin/submissions/sub-1/review': () =>
        new Response(JSON.stringify({ error: { code: 'MODEL_EXISTS', message: '模型已存在' } }), { status: 409 }),
    });
    await unlock();
    fireEvent.click(await screen.findByRole('button', { name: '通过' }));
    expect(await screen.findByText('模型已存在')).toBeInTheDocument();
    // 失败不该把已经取到的内容清空。
    expect(within(screen.getByRole('list')).getByText('示例站 · https://a.example.com/')).toBeInTheDocument();
  });
});

describe('审核台的批量语义', () => {
  it('批量审核部分失败时必须报出来，不能显示全部成功', async () => {
    const second = { ...submission, id: 'sub-2', originKey: 'b.example.com', payload: { name: '第二站', url: 'https://b.example.com/' } };
    stubApi({
      'GET /api/admin/submissions': { items: [submission, second], total: 2 },
      // 后端逐条独立事务：单条失败仍是 HTTP 200，错误只在 results[].error 里。
      'POST /api/admin/submissions/batch-review': {
        results: [{ id: 'sub-1', submission: { ...submission, status: 'approved' } },
          { id: 'sub-2', error: { status: 409, code: 'MODEL_EXISTS', message: '模型 m 已存在' } }],
      },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('button', { name: '全部通过' }));
    expect(await screen.findByText('1 条未通过：模型 m 已存在')).toBeInTheDocument();
  });

  it('待审超过一页时翻页取全，而不是只看第一页 50 条', async () => {
    const page = (from: number) => Array.from({ length: 50 }, (_, index) => ({
      ...submission, id: `sub-${from + index}`, originKey: `s${from + index}.example.com`,
      payload: { name: `站 ${from + index}`, url: `https://s${from + index}.example.com/` },
    }));
    const first = page(0);
    const second = page(50);
    const fetchMock = stubApi({
      'GET /api/admin/submissions': ({ url }: StubRequest) => (url.searchParams.get('page') === '2'
        ? { items: second, total: 100 }
        : { items: first, total: 100 }),
    });
    await unlock();
    expect(await screen.findByRole('tab', { name: '待审投稿 (100)' })).toBeInTheDocument();
    const pages = callsTo(fetchMock, 'GET', '/api/admin/submissions').map(call => call.url.searchParams.get('page'));
    expect(pages).toContain('2');
  });

  it('取消二次确认时不发批量请求', async () => {
    vi.stubGlobal('confirm', () => false);
    const fetchMock = stubApi({ 'GET /api/admin/submissions': { items: [submission], total: 1 } });
    await unlock();
    fireEvent.click(await screen.findByRole('button', { name: '全部通过' }));
    expect(callsTo(fetchMock, 'POST', '/api/admin/submissions/batch-review')).toHaveLength(0);
  });

  it('退出后清空内存里的列表，不留残留数据', async () => {
    stubApi({ 'GET /api/admin/submissions': { items: [submission], total: 1 } });
    await unlock();
    await screen.findByText('示例站 · https://a.example.com/');
    fireEvent.click(screen.getByRole('button', { name: '退出' }));
    // 回到入口态，旧列表不再渲染。
    expect(await screen.findByLabelText('管理密钥')).toBeInTheDocument();
    expect(screen.queryByText('示例站 · https://a.example.com/')).not.toBeInTheDocument();
  });
  it('superseded 单独披露，不混进「已通过」', async () => {
    // 被同站新版本替代的行线上是另一版；笼统算进「已通过」会让审核员
    // 以为这批内容都按自己看到的版本上线了。
    stubApi({ 'GET /api/admin/submissions': { items: [submission], total: 1 },
      'POST /api/admin/submissions/batch-review': { results: [
        { id: 'sub-1', status: 'superseded', reason: null },
      ] } });
    await unlock();
    fireEvent.click(await screen.findByRole('button', { name: /全部通过/ }));
    expect(await screen.findByText(/已被同站新版本替代/)).toBeInTheDocument();
    expect(screen.queryByText(/^已通过 1 条$/)).not.toBeInTheDocument();
  });

  it('页签有 tablist/tab 语义，「退出」不冒充页签', async () => {
    stubApi({ 'GET /api/admin/submissions': { items: [submission], total: 1 } });
    await unlock();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    // 待审投稿 / 待审文章 / 已上线文章 / 已下架站点 / 已下架文章 / 举报
    expect(tabs.map(tab => tab.textContent?.trim().split(' ')[0])).toEqual(['待审投稿', '待审文章', '已上线文章', '已下架站点', '已下架文章', '举报']);
    expect(tabs.some(tab => tab.textContent?.includes('退出'))).toBe(false);
    expect(screen.getByRole('tab', { name: /待审投稿/ })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('拒绝理由与时间兜底', () => {
  it('拒绝时可以填理由，理由随请求一起提交，作者能在 /me 看到', async () => {
    const fetchMock = stubApi({
      'GET /api/admin/submissions': { items: [submission], total: 1 },
      'POST /api/admin/submissions/sub-1/review': { ...submission, status: 'rejected', reason: '链接打不开' },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('button', { name: '拒绝' }));
    // 先展开理由输入，再确认，避免误点直接驳回。
    fireEvent.change(screen.getByLabelText('驳回理由（可选）'), { target: { value: ' 链接打不开 ' } });
    fireEvent.click(screen.getByRole('button', { name: '确认拒绝' }));
    expect(await screen.findByText('已拒绝')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/admin/submissions/sub-1/review')[0].body)
      .toEqual({ status: 'rejected', reason: '链接打不开' });
  });

  it('理由留空时不传 reason 字段', async () => {
    const fetchMock = stubApi({
      'GET /api/admin/submissions': { items: [submission], total: 1 },
      'POST /api/admin/submissions/sub-1/review': { ...submission, status: 'rejected' },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('button', { name: '拒绝' }));
    fireEvent.click(screen.getByRole('button', { name: '确认拒绝' }));
    await screen.findByText('已拒绝');
    expect(callsTo(fetchMock, 'POST', '/api/admin/submissions/sub-1/review')[0].body).toEqual({ status: 'rejected' });
  });

  it('下架时间不合法时显示「时间未知」，不渲染 Invalid Date', async () => {
    stubApi({
      'GET /api/admin/submissions': { items: [], total: 0 },
      'GET /api/admin/stations/removed': { items: [{ slug: 'bad-time', removedAt: 'not-a-date' }] },
    });
    await unlock();
    fireEvent.click(await screen.findByRole('tab', { name: /已下架站点/ }));
    expect(await screen.findByText('下架于 时间未知')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
  });
});

describe('管理接口被反代挡住时的提示', () => {
  it('404 解释成「未对公网开放」而不是「请求失败」', async () => {
    // nginx 模板对 /api/admin/ 直接 return 404。不解释的话，运维只会看到
    // 「请求失败（404）」然后去翻后端日志，而后端根本没收到请求。
    adminToken.set('k'.repeat(32));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    await expect(admin.listSubmissions('pending')).rejects.toThrow(/未对公网开放/);
  });
});

describe('管理密钥被拒时的反馈', () => {
  it('密钥无效时退回输入态并说明原因，而不是静默清空', async () => {
    adminToken.set('k'.repeat(32));
    // 键是「方法 路径」；返回体用 apiError 拼成标准错误形状。
    stubApi({ 'GET /api/admin/submissions': apiError(403, 'FORBIDDEN', 'token 无效') });
    renderApp('/admin');
    // 退回输入态：输入框重新出现
    expect(await screen.findByLabelText(/管理密钥/)).toBeTruthy();
    // 且必须给出原因，否则用户以为按钮没反应
    expect(await screen.findByText(/管理密钥无效/)).toBeTruthy();
    // 失效的密钥不应该留在存储里
    expect(sessionStorage.getItem('zdd.adminToken')).toBeNull();
  });
});

describe('待审卡片的变更提示', () => {
  const stationItem = (slug: string, url: string, lowestRate: number) => ({
    slug, name: slug, url, description: '现在的描述', lowestRate,
  });
  const pendingStation = (url: string, channel = 'feishu') => ({
    ...submission, channel,
    payload: {
      name: '示例站', url, description: '被换掉的描述',
      rechargeThreshold: null, paymentMethods: [], offers: [{ modelSlug: 'claude-sonnet', rate: 0.3 }],
    },
  });

  it('站点地址是 FQDN 尾点写法时，也认出「已有站点」而不是「新建」', async () => {
    // 归一不一致时，尾点站会被当成新站，审核员看不到「这一通过会覆盖什么」。
    stubApi({
      'GET /api/admin/submissions': { items: [pendingStation('https://dotui.example.com/')], total: 1 },
      'GET /api/stations': { items: [stationItem('sub-dotui-example-com', 'https://dotui.example.com./', 0.9)], total: 1 },
    });
    await unlock();
    expect(await screen.findByText(/更新已有站点/)).toBeInTheDocument();
    expect(screen.queryByText(/新建站点/)).not.toBeInTheDocument();
  });

  it('agent 渠道且站点地址带尾点时，仍认作更新（这一层没有分组兜底）', async () => {
    // 非飞书渠道不分组，不存在「分组兜底」替它兜住尾点差异，所以这条专门钉精确层：
    // 少一次去尾点，审核员就会看到「新建站点」，而实际是覆盖已有站。
    stubApi({
      'GET /api/admin/submissions': { items: [pendingStation('https://dotagent2.example.com/', 'agent')], total: 1 },
      'GET /api/stations': { items: [stationItem('sub-dotagent2', 'https://dotagent2.example.com./', 0.9)], total: 1 },
    });
    await unlock();
    expect(await screen.findByText(/更新已有站点/)).toBeInTheDocument();
    expect(screen.queryByText(/新建站点/)).not.toBeInTheDocument();
  });

  it('www 与裸域各有一条站时，按精确 hostname 命中，不取错的那条', async () => {
    // 服务端认领是「精确优先」。只按飞书分组键找会取到另一条，倍率提示就指错了站。
    stubApi({
      'GET /api/admin/submissions': { items: [pendingStation('https://twin.example.com/')], total: 1 },
      'GET /api/stations': {
        items: [
          stationItem('sub-twin', 'https://twin.example.com/', 0.9),
          stationItem('sub-www-twin', 'https://www.twin.example.com/', 0.5),
        ],
        total: 2,
      },
    });
    await unlock();
    // 投稿是裸域 → 必须拿裸域那条的 0.9x
    expect(await screen.findByText(/最低倍率 0\.9x → 0\.3x/)).toBeInTheDocument();
  });

  it('web/agent 渠道不套用飞书分组：只会新建站时如实提示「新建站点」', async () => {
    // 服务端只对 channel==='feishu' 分组；web/agent 投 www 写法会另建一条站。
    // 审核台若照飞书口径分组，会误报「更新已有站点」，审核员以为在覆盖。
    stubApi({
      'GET /api/admin/submissions': { items: [pendingStation('https://www.solo.example.com/', 'agent')], total: 1 },
      'GET /api/stations': { items: [stationItem('sub-solo', 'https://solo.example.com/', 0.9)], total: 1 },
    });
    await unlock();
    expect(await screen.findByText(/新建站点/)).toBeInTheDocument();
    expect(screen.queryByText(/更新已有站点/)).not.toBeInTheDocument();
  });

  it('飞书渠道仍然按分组兜底：www 写法更新裸域那条站', async () => {
    stubApi({
      'GET /api/admin/submissions': { items: [pendingStation('https://www.solo.example.com/', 'feishu')], total: 1 },
      'GET /api/stations': { items: [stationItem('sub-solo', 'https://solo.example.com/', 0.9)], total: 1 },
    });
    await unlock();
    expect(await screen.findByText(/更新已有站点/)).toBeInTheDocument();
  });

  it('站点更新时提示报价将被整包替换，并给出最低倍率变化', async () => {
    // 线上已有该站点（catalog 带 lowestRate），投稿会把报价整包替换掉
    stubApi({
      'GET /api/admin/submissions': {
        items: [{
          ...submission, channel: 'agent', actorHandle: 'someone',
          payload: {
            slug: 'sub-a-example-com', name: '示例站', url: 'https://a.example.com/', description: '被换掉的描述',
            rechargeThreshold: null, paymentMethods: [], offers: [{ modelSlug: 'claude-sonnet', rate: 0.3 }],
          },
        }],
        total: 1,
      },
      'GET /api/stations': {
        // url 必须给：审核台按 hostname 反查当前站点（payload 里没有 slug）。
        items: [{ slug: 'sub-a-example-com', name: '示例站', url: 'https://a.example.com/', description: '现在的描述', lowestRate: 0.9 }],
        total: 1,
      },
    });
    await unlock();
    // 审核员必须看到「这一通过会替换报价」以及倍率会变成多少
    expect(await screen.findByText(/报价将被整包替换为 1 条/)).toBeInTheDocument();
    expect(await screen.findByText(/最低倍率 0\.9x → 0\.3x/)).toBeInTheDocument();
  });
});

describe('Hook顺序', () => {
 it('锁定态和解锁态渲染的 hook数量一致，不触发 React的 Hooks警告', async () => {
 // 回归：`useCatalog()` 曾经被放在 `if (!token) return ...` 之后。锁定态渲染到
 // useEffect 就结束，解锁态多出一个 useContext，React 直接报
 // 「change in the order of Hooks」——这是硬性规则，不是可以忽略的警告。
 const errors: string[] = [];
 const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
 errors.push(args.map(String).join(' '));
 });
 try {
 await unlock();
 await screen.findByRole('heading', { name: '审核台' });
 expect(errors.filter(line => /order of Hooks/.test(line))).toEqual([]);
 } finally {
 spy.mockRestore();
 }
 });
});
