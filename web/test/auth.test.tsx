import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLocation } from 'react-router';
import App from '../src/App';
import { makePost, me, page, station } from './fixtures';
import { apiError, callsTo, deferred, json, renderApp, renderWithProviders, stubApi } from './helpers';

const signedOut = { 'GET /api/me': () => apiError(401, 'UNAUTHENTICATED', '请先登录') };

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}
const where = () => screen.getByTestId('where').textContent;
const renderAt = (route: string) => renderWithProviders(<><App /><Where /></>, route);
const navigation = () => within(screen.getByRole('navigation', { name: '主导航' }));
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('未登录', () => {
  it('导航显示登录和注册，不出现任何账号', async () => {
    stubApi(signedOut);
    renderApp('/');
    expect(await navigation().findByRole('link', { name: '登录' })).toBeInTheDocument();
    expect(navigation().getByRole('link', { name: '注册' })).toHaveAttribute('href', '/register');
    expect(screen.queryByText(/虚构踏板/)).not.toBeInTheDocument();
    expect(screen.queryByText(/用户加载失败/)).not.toBeInTheDocument();
  });

  it('用户卡显示引导语和登录按钮，签到跳登录页且不发请求', async () => {
    const fetchMock = stubApi(signedOut);
    renderAt('/');
    const card = within(screen.getByRole('complementary', { name: '当前用户' }));
    expect(await card.findByText('Hi~ 登录发现更多精彩')).toBeInTheDocument();
    expect(card.getByRole('link', { name: '登录' })).toHaveAttribute('href', '/login?next=%2F');
    fireEvent.click(card.getByRole('link', { name: '签到领Token' }));
    await waitFor(() => expect(where()).toBe('/login?next=%2F'));
    expect(callsTo(fetchMock, 'POST', '/api/me/checkin')).toEqual([]);
  });

  it('点投票跳登录并记住当前页，不发写请求', async () => {
    const fetchMock = stubApi({ ...signedOut, 'GET /api/posts/p1': makePost('p1') });
    renderAt('/posts/p1');
    await navigation().findByRole('link', { name: '登录' });
    fireEvent.click(await screen.findByRole('button', { name: /^值/ }));
    await waitFor(() => expect(where()).toBe('/login?next=%2Fposts%2Fp1'));
    expect(callsTo(fetchMock, 'PUT', '/api/votes')).toEqual([]);
  });

  it('点收藏跳登录，不发写请求', async () => {
    const fetchMock = stubApi({ ...signedOut, 'GET /api/posts/p1': makePost('p1') });
    renderAt('/posts/p1');
    await navigation().findByRole('link', { name: '登录' });
    fireEvent.click(await screen.findByRole('button', { name: '收藏' }));
    await waitFor(() => expect(where()).toBe('/login?next=%2Fposts%2Fp1'));
    expect(callsTo(fetchMock, 'PUT', '/api/favorites')).toEqual([]);
  });

  it('评论区显示登录入口而不是输入框，回复也跳登录', async () => {
    const comment = { id: 'c1', targetType: 'post', targetId: 'p1', author: me, content: '一条评论', parentId: null, createdAt: '2026-11-03T08:00:00.000Z', replies: [] };
    stubApi({ ...signedOut, 'GET /api/posts/p1': makePost('p1'), 'GET /api/comments': page([comment]) });
    renderAt('/posts/p1');
    await navigation().findByRole('link', { name: '登录' });
    const section = within(await screen.findByRole('region', { name: '评论' }));
    expect(await section.findByRole('link', { name: '登录' })).toHaveAttribute('href', '/login?next=%2Fposts%2Fp1');
    expect(section.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(await section.findByRole('button', { name: '回复' }));
    await waitFor(() => expect(where()).toBe('/login?next=%2Fposts%2Fp1'));
  });

  it('投稿页和我的页都引导登录，不报错', async () => {
    stubApi(signedOut);
    const { unmount } = renderApp('/submit');
    const main = within(screen.getByRole('main'));
    expect(await main.findByRole('link', { name: '登录' })).toHaveAttribute('href', '/login?next=%2Fsubmit');
    expect(main.queryByLabelText('标题')).not.toBeInTheDocument();
    unmount();
    renderApp('/me?tab=posts');
    expect(await within(screen.getByRole('main')).findByRole('link', { name: '登录' })).toHaveAttribute('href', '/login?next=%2Fme%3Ftab%3Dposts');
  });
});

describe('登录页', () => {
  it('校验必填，不发请求', async () => {
    const fetchMock = stubApi(signedOut);
    renderApp('/login');
    fireEvent.click(await screen.findByRole('button', { name: '登录' }));
    expect(await screen.findByText('请填写用户名')).toBeInTheDocument();
    expect(screen.getByText('请填写密码')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/auth/login')).toEqual([]);
  });

  it('密码错误显示服务端文案，可以重试', async () => {
    stubApi({ ...signedOut, 'POST /api/auth/login': () => apiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误') });
    renderApp('/login');
    type('用户名', 'alice');
    type('密码', 'wrong-password');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码错误');
    expect(screen.getByRole('button', { name: '登录' })).toBeEnabled();
  });

  it('提交中禁用按钮，成功后回跳并显示昵称', async () => {
    const pending = deferred<Response>();
    const fetchMock = stubApi({ ...signedOut, 'POST /api/auth/login': () => pending.promise, 'GET /api/posts/p1': makePost('p1') });
    renderAt('/login?next=%2Fposts%2Fp1');
    type('用户名', 'alice');
    type('密码', 'correct-horse');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('button', { name: '登录中…' })).toBeDisabled();
    pending.resolve(json(me));
    await waitFor(() => expect(where()).toBe('/posts/p1'));
    expect(await navigation().findByRole('button', { name: me.nickname })).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/auth/login')[0].body).toEqual({ username: 'alice', password: 'correct-horse' });
  });

  it.each(['//evil.example', 'https://evil.example', '/\\evil.example', '/\t/evil.example'])('回跳地址 %j 不是站内路径时回首页', async next => {
    stubApi({ ...signedOut, 'POST /api/auth/login': () => json(me) });
    renderAt(`/login?next=${encodeURIComponent(next)}`);
    type('用户名', 'alice');
    type('密码', 'correct-horse');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(where()).toBe('/'));
  });

  it('已登录时访问登录页直接回跳', async () => {
    stubApi();
    renderAt('/login?next=%2Fdocs');
    await waitFor(() => expect(where()).toBe('/docs'));
  });

  it('注册入口带上回跳地址', async () => {
    stubApi(signedOut);
    renderApp('/login?next=%2Fdocs');
    expect(await within(screen.getByRole('main')).findByRole('link', { name: '去注册' })).toHaveAttribute('href', '/register?next=%2Fdocs');
  });
});

describe('注册页', () => {
  const fill = (username: string, password: string, confirm = password) => {
    type('用户名', username);
    type('密码', password);
    type('确认密码', confirm);
  };

  it('写明不支持找回密码', async () => {
    stubApi(signedOut);
    renderApp('/register');
    expect(await screen.findByText(/暂不支持找回密码，请妥善保存/)).toBeInTheDocument();
  });

  it.each([
    ['ab', 'correct-horse', 'correct-horse', '用户名须为 3~20 位字母、数字或下划线'],
    ['爱丽丝', 'correct-horse', 'correct-horse', '用户名须为 3~20 位字母、数字或下划线'],
    ['alice', '1234567', '1234567', '密码至少 8 位'],
    ['alice', 'correct-horse', 'different-horse', '两次输入的密码不一致'],
  ])('校验 %s / %s', async (username, password, confirm, message) => {
    const fetchMock = stubApi(signedOut);
    renderApp('/register');
    fill(username, password, confirm);
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/auth/register')).toEqual([]);
  });

  it('用户名已被注册时显示服务端文案', async () => {
    stubApi({ ...signedOut, 'POST /api/auth/register': () => apiError(409, 'USERNAME_TAKEN', '这个用户名已被注册') });
    renderApp('/register');
    fill('alice', 'correct-horse');
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('这个用户名已被注册');
  });

  it('成功后回跳，昵称可选', async () => {
    const fetchMock = stubApi({ ...signedOut, 'POST /api/auth/register': () => json(me) });
    renderAt('/register?next=%2Fdocs');
    fill('alice', 'correct-horse');
    type(/昵称/, '爱丽丝');
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    await waitFor(() => expect(where()).toBe('/docs'));
    expect(callsTo(fetchMock, 'POST', '/api/auth/register')[0].body).toEqual({ username: 'alice', password: 'correct-horse', nickname: '爱丽丝' });
  });
});

describe('已登录', () => {
  it('导航显示昵称，菜单含我的和退出登录；退出后回到未登录态', async () => {
    const fetchMock = stubApi({ 'POST /api/auth/logout': () => json({ ok: true }) });
    renderAt('/docs');
    fireEvent.click(await navigation().findByRole('button', { name: me.nickname }));
    expect(navigation().getByRole('link', { name: '我的' })).toHaveAttribute('href', '/me');
    fireEvent.click(navigation().getByRole('button', { name: '退出登录' }));
    expect(await navigation().findByRole('link', { name: '登录' })).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/auth/logout')).toHaveLength(1);
  });

  it('退出失败时保持登录并提示', async () => {
    stubApi({ 'POST /api/auth/logout': () => apiError(500, 'INTERNAL', '退出失败') });
    renderApp('/docs');
    fireEvent.click(await navigation().findByRole('button', { name: me.nickname }));
    fireEvent.click(navigation().getByRole('button', { name: '退出登录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('退出失败');
    expect(navigation().getByRole('button', { name: me.nickname })).toBeInTheDocument();
  });

  it('投稿成功后说明要审核，并跳到我的分享', async () => {
    stubApi({ 'POST /api/posts': () => json(makePost('new', { status: 'pending' })) });
    renderAt('/submit');
    fireEvent.change(await screen.findByLabelText('标题'), { target: { value: '标题' } });
    type('摘要', '摘要');
    fireEvent.change(screen.getByLabelText(/正文/), { target: { value: '正文' } });
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));
    await waitFor(() => expect(where()).toBe('/me?tab=posts'));
    expect(await screen.findByRole('alert')).toHaveTextContent('已提交，审核通过后公开');
  });

  it('我的分享标注审核中和未通过', async () => {
    stubApi({ 'GET /api/me/posts': page([makePost('a', { status: 'pending', title: '待审' }), makePost('b', { status: 'rejected', title: '被拒' }), makePost('c', { title: '已通过' })]) });
    renderApp('/me?tab=posts');
    expect(await screen.findByText('审核中')).toBeInTheDocument();
    expect(screen.getByText('未通过')).toBeInTheDocument();
    expect(screen.getAllByText(/审核中|未通过/)).toHaveLength(2);
  });

  it('作者打开待审投稿时顶部说明只有自己可见', async () => {
    stubApi({ 'GET /api/posts/p1': makePost('p1', { status: 'pending', source: 'user' }), 'GET /api/stations': page([station]) });
    renderApp('/posts/p1');
    expect(await within(screen.getByRole('main')).findByRole('note')).toHaveTextContent('审核中，目前只有你自己看得到');
  });
});
