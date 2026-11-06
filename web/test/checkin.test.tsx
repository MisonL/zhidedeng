import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import UserCard from '../src/components/UserCard';
import { me } from './fixtures';
import { apiError, deferred, json, renderWithProviders, stubApi } from './helpers';

const success = { userHandle: 'demo-pedal', date: '2026-11-04', tokensAwarded: 10, streak: 4, tokens: 1290, checkedInToday: true };
const balance = (value: string) => screen.findByLabelText(`Token 余额 ${value}`);
const checkInButton = () => screen.findByRole('button', { name: '签到领Token' });

describe('签到', () => {
  it('乐观切换为已签到，成功后 Token 滚动到新余额', async () => {
    const pending = deferred<Response>();
    stubApi({ 'POST /api/me/checkin': () => pending.promise });
    renderWithProviders(<UserCard />);

    await balance('1280');
    fireEvent.click(await checkInButton());
    expect(screen.getByRole('button', { name: /已签到/ })).toBeInTheDocument();

    await act(async () => {
      pending.resolve(json(success));
      await pending.promise;
    });
    await balance('1290');
    expect(screen.getByRole('button', { name: /已签到.*4 天/ })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('+10');
  });

  it('失败时回滚为可签到并提示', async () => {
    stubApi({ 'POST /api/me/checkin': () => apiError(500, 'INTERNAL', '签到服务异常') });
    renderWithProviders(<UserCard />);

    fireEvent.click(await checkInButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('签到服务异常');
    expect(await checkInButton()).toBeEnabled();
    await balance('1280');
  });

  it('409 视为今日已签到并同步最新用户数据', async () => {
    let checked = false;
    stubApi({
      'GET /api/me': () => (checked ? { ...me, tokens: 1300, checkedInToday: true, streak: 5 } : me),
      'POST /api/me/checkin': () => { checked = true; return apiError(409, 'ALREADY_CHECKED_IN', '今天已经签到过了'); },
    });
    renderWithProviders(<UserCard />);

    fireEvent.click(await checkInButton());
    await balance('1300');
    await waitFor(() => expect(screen.getByRole('button', { name: /已签到.*5 天/ })).toBeDisabled());
    expect(screen.getByRole('alert')).toHaveTextContent('今天已经签到过了');
  });

  it('已签到用户直接显示已签到', async () => {
    stubApi({ 'GET /api/me': { ...me, checkedInToday: true } });
    renderWithProviders(<UserCard />);
    expect(await screen.findByRole('button', { name: /已签到/ })).toBeDisabled();
  });

  it('用户加载失败显示错误并可重试', async () => {
    let attempts = 0;
    stubApi({ 'GET /api/me': () => (++attempts === 1 ? apiError(500, 'INTERNAL', '用户服务异常') : me) });
    renderWithProviders(<UserCard />);

    expect(await screen.findByText('用户服务异常')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('虚构踏板（demo-pedal）')).toBeInTheDocument();
  });
});
