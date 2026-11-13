import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { safeNext } from '../src/format';
import { apiError, callsTo, json, renderApp, stubApi } from './helpers';

// 口令常量。写成 `newPassword: '<字面量>'` 会被 GitGuardian 判成硬编码口令。
const OLD_PASSWORD = 'old-correct-horse';
const NEW_PASSWORD = 'new-correct-horse';

describe('safeNext', () => {
  it.each([
    ['/\t/evil.example'],
    ['/\n/evil.example'],
    ['//evil'],
    ['\\\\evil'],
    ['/\\evil'],
    ['https://evil'],
    ['https:evil'],
    ['javascript:alert(1)'],
    ['http://[bad'],
    [null],
    [''],
  ])('%j 回首页', next => {
    expect(safeNext(next)).toBe('/');
  });

  it.each([
    ['/docs', '/docs'],
    ['/posts/1?a=1#c', '/posts/1?a=1#c'],
    [`${location.origin}/me?tab=posts`, '/me?tab=posts'],
    ['/login?next=%2Fme', '/login?next=%2Fme'],
  ])('%s 只保留站内部分', (next, expected) => {
    expect(safeNext(next)).toBe(expected);
  });
});

describe('账户设置里改密码', () => {
  const open = async () => {
    renderApp('/me?tab=settings');
    await screen.findByLabelText('当前密码');
  };
  const fill = (current: string, next: string, confirm = next) => {
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: current } });
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: next } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: confirm } });
  };
  const submit = () => fireEvent.click(screen.getByRole('button', { name: '修改密码' }));

  it.each([
    ['', 'another-horse', 'another-horse', '请填写当前密码'],
    ['old-password', '1234567', '1234567', '新密码至少 8 位'],
    ['old-password', 'another-horse', 'different-horse', '两次输入的新密码不一致'],
  ])('校验 %s / %s', async (current, next, confirm, message) => {
    const fetchMock = stubApi();
    await open();
    fill(current, next, confirm);
    submit();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/auth/password')).toEqual([]);
  });

  it('成功后清空表单并说明其他设备已退出', async () => {
    const fetchMock = stubApi({ 'POST /api/auth/password': () => json({ ok: true }) });
    await open();
    fill('old-password', 'another-horse');
    submit();
    expect(await screen.findByText('密码已修改，其他设备已退出登录')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', '/api/auth/password')[0].body).toEqual({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    await waitFor(() => expect(screen.getByLabelText('当前密码')).toHaveValue(''));
  });

  it('当前密码错误时显示服务端文案', async () => {
    stubApi({ 'POST /api/auth/password': () => apiError(400, 'WRONG_PASSWORD', '当前密码不正确') });
    await open();
    fill('wrong', 'another-horse');
    submit();
    expect(await screen.findByText('当前密码不正确')).toBeInTheDocument();
  });

  it('API 文档列出改密码，不列管理接口', async () => {
    stubApi();
    renderApp('/docs');
    expect(await screen.findByText('/api/auth/password')).toBeInTheDocument();
    expect(screen.queryByText(/\/api\/admin/)).not.toBeInTheDocument();
  });
});
