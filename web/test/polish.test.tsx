import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PostCard from '../src/components/PostCard';
import RankingBoard from '../src/components/RankingBoard';
import StationCard from '../src/components/StationCard';
import { makePost, station } from './fixtures';
import { renderApp, renderWithProviders, stubApi } from './helpers';

describe('差异化封面', () => {
  it('按文章类型出不同封面，数字取自关联站点', async () => {
    stubApi();
    const { container } = renderWithProviders(
      <>
        <PostCard post={makePost('d', { kind: 'deal' })} />
        <PostCard post={makePost('r', { kind: 'review' })} />
        <PostCard post={makePost('g', { kind: 'guide', title: '云栈 · 先测稳定再看倍率' })} />
        <PostCard post={makePost('c', { kind: 'community', title: '晚高峰稳不稳' })} />
      </>,
    );

    // 站点目录异步加载，到位后爆料封面显示最低倍率、评测封面显示可用率。
    await waitFor(() => expect(container.querySelector('.cover-deal .cover-value')).toHaveAttribute('data-value', '0.6'));
    expect(container.querySelector('.cover-review .cover-value')).toHaveAttribute('data-value', '99.2');
    expect(container.querySelector('.cover-review .cover-meter')).toHaveAttribute('data-value', '首 token 420 ms');
    expect(container.querySelector('.cover-guide .cover-pitch')).toHaveAttribute('data-pitch', '先测稳定再看倍率');
    expect(container.querySelector('.cover-community .cover-pitch')).toHaveAttribute('data-pitch', '晚高峰稳不稳');
  });

  it('封面是装饰：对读屏隐藏，且不往页面里多塞一份倍率文字', async () => {
    stubApi();
    const { container } = renderWithProviders(<PostCard post={makePost('d', { kind: 'deal' })} />);
    expect(await screen.findByText('云栈 低至 0.6x')).toBeInTheDocument();
    expect(container.querySelector('.cover')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByText('0.6')).not.toBeInTheDocument();
  });

  it('站点封面取「虚构·」之后的首字，并带最低倍率', () => {
    stubApi();
    const { container } = renderWithProviders(<StationCard station={{ ...station, name: '虚构·大肥鱼试验站' }} />);
    const cover = container.querySelector('.cover-station');
    expect(cover).toHaveAttribute('data-glyph', '大');
    expect(cover?.querySelector('.cover-strip')).toHaveAttribute('data-value', '0.6x');
  });
});

describe('排行榜卡片', () => {
  it('前三名用分级角标，封面文字不混进链接名称', async () => {
    stubApi();
    const { container } = renderWithProviders(<RankingBoard />);
    const link = await screen.findByRole('link', { name: /DeepSeek V4/ });
    expect(container.querySelector('.rank-ribbon')).toHaveClass('rank-top-1');
    expect(container.querySelector('.cover-model')).toHaveAttribute('data-mark', 'DeepSeek V4');
    expect(link).toHaveAccessibleName(/^TOP 1\s*DeepSeek V4\s*低至 0.5x · 8 站可选$/);
  });
});

describe('404 页', () => {
  it('用印章拼出 404，并给出回首页入口', async () => {
    stubApi();
    const { container } = renderApp('/nope');
    expect(await screen.findByRole('heading', { name: '页面不存在' })).toBeInTheDocument();
    expect(container.querySelector('.notfound-art')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('.notfound-art img')).toHaveAttribute('src', '/favicon.svg');
    expect(screen.getByRole('link', { name: '回到首页' })).toHaveAttribute('href', '/');
  });
});
