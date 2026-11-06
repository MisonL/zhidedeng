import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FavoriteButton from '../src/components/FavoriteButton';
import VoteButtons from '../src/components/VoteButtons';
import { apiError, callsTo, deferred, json, renderWithProviders, stubApi } from './helpers';

const votes = { up: 3, down: 1, total: 4, upRatio: 0.75 };
const up = () => screen.getByRole('button', { name: /^值/ });
const down = () => screen.getByRole('button', { name: /^不值/ });
const target = { targetType: 'post', targetId: 'p1' } as const;

describe('值/不值投票', () => {
  it('点击立即乐观更新，响应后采用服务端汇总', async () => {
    const pending = deferred<Response>();
    const fetchMock = stubApi({ 'PUT /api/votes': () => pending.promise });
    renderWithProviders(<VoteButtons {...target} votes={votes} currentUserVote={null} />);

    fireEvent.click(up());
    expect(up()).toHaveAttribute('aria-pressed', 'true');
    expect(up()).toHaveTextContent('4');
    expect(screen.getByText('80%')).toBeInTheDocument();

    await waitFor(() => expect(callsTo(fetchMock, 'PUT', '/api/votes')).toHaveLength(1));
    expect(callsTo(fetchMock, 'PUT', '/api/votes')[0].body).toEqual({ ...target, value: 'up' });

    await act(async () => {
      pending.resolve(json({ ...target, votes: { up: 10, down: 1, total: 11, upRatio: 10 / 11 }, currentUserVote: 'up' }));
      await pending.promise;
    });
    await waitFor(() => expect(up()).toHaveTextContent('10'));
    expect(screen.getByText('91%')).toBeInTheDocument();
  });

  it('失败时回滚到投票前状态并提示', async () => {
    const pending = deferred<Response>();
    stubApi({ 'PUT /api/votes': () => pending.promise });
    renderWithProviders(<VoteButtons {...target} votes={votes} currentUserVote="down" />);

    fireEvent.click(up());
    expect(up()).toHaveTextContent('4');
    expect(down()).toHaveTextContent('0');

    await act(async () => {
      pending.resolve(apiError(500, 'INTERNAL', '服务器开小差'));
      await pending.promise;
    });
    await waitFor(() => expect(down()).toHaveAttribute('aria-pressed', 'true'));
    expect(up()).toHaveAttribute('aria-pressed', 'false');
    expect(up()).toHaveTextContent('3');
    expect(down()).toHaveTextContent('1');
    expect(await screen.findByRole('alert')).toHaveTextContent('服务器开小差');
  });

  it('再次点击同一项撤销投票，发送 null', async () => {
    const fetchMock = stubApi({
      'PUT /api/votes': { ...target, votes: { up: 2, down: 1, total: 3, upRatio: 2 / 3 }, currentUserVote: null },
    });
    renderWithProviders(<VoteButtons {...target} votes={votes} currentUserVote="up" />);

    fireEvent.click(up());
    expect(up()).toHaveAttribute('aria-pressed', 'false');
    expect(up()).toHaveTextContent('2');
    await waitFor(() => expect(callsTo(fetchMock, 'PUT', '/api/votes')[0].body).toEqual({ ...target, value: null }));
  });

  it('请求进行中忽略重复点击', async () => {
    const pending = deferred<Response>();
    const fetchMock = stubApi({ 'PUT /api/votes': () => pending.promise });
    renderWithProviders(<VoteButtons {...target} votes={votes} currentUserVote={null} />);

    fireEvent.click(up());
    fireEvent.click(down());
    expect(up()).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(callsTo(fetchMock, 'PUT', '/api/votes')).toHaveLength(1));
    await act(async () => {
      pending.resolve(json({ ...target, votes, currentUserVote: 'up' }));
      await pending.promise;
    });
  });
});

describe('收藏', () => {
  it('乐观更新，成功后采用服务端数量', async () => {
    const pending = deferred<Response>();
    const fetchMock = stubApi({ 'PUT /api/favorites': () => pending.promise });
    renderWithProviders(<FavoriteButton {...target} favorited={false} favoriteCount={7} />);

    const button = screen.getByRole('button', { name: /收藏/ });
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveTextContent('8');
    await waitFor(() => expect(callsTo(fetchMock, 'PUT', '/api/favorites')[0].body).toEqual({ ...target, favorited: true }));

    await act(async () => {
      pending.resolve(json({ ...target, favorited: true, favoriteCount: 20 }));
      await pending.promise;
    });
    await waitFor(() => expect(button).toHaveTextContent('20'));
  });

  it('失败时回滚并提示', async () => {
    stubApi({ 'PUT /api/favorites': () => apiError(500, 'INTERNAL', '收藏没成功') });
    renderWithProviders(<FavoriteButton {...target} favorited favoriteCount={7} />);

    const button = screen.getByRole('button', { name: /收藏/ });
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(await screen.findByRole('alert')).toHaveTextContent('收藏没成功');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveTextContent('7');
  });
});
