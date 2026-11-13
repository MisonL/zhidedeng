import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { admin, adminToken } from '../src/admin';
import { callsTo, renderApp, stubApi } from './helpers';
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
    fireEvent.click(await screen.findByRole('button', { name: /待审文章/ }));
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
    fireEvent.click(await screen.findByRole('button', { name: /已下架站点/ }));
    expect(await screen.findByText('gone-example-com')).toBeInTheDocument();
    // 下架时间是排障信息，必须显示出来。
    expect(screen.getByText(/下架于/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    expect(await screen.findByText('已恢复')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/admin/stations/gone-example-com/restore')).toHaveLength(1);
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
    expect(await screen.findByRole('button', { name: '待审投稿 (100)' })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole('button', { name: /已下架站点/ }));
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
