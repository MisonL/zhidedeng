import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BannerCarousel from '../src/components/BannerCarousel';
import { banners } from './fixtures';
import { renderWithProviders, stubApi } from './helpers';

const heading = (name: string) => screen.queryByRole('heading', { name });

describe('Banner 轮播', () => {
  it('左右箭头循环切换，圆点直达', () => {
    stubApi();
    renderWithProviders(<BannerCarousel banners={banners} />);
    expect(heading('鲸鱼新版评测')).toBeInTheDocument();
    expect(heading('蹬车省钱指南')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    expect(heading('蹬车省钱指南')).toBeInTheDocument();
    expect(heading('鲸鱼新版评测')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '上一张' }));
    fireEvent.click(screen.getByRole('button', { name: '上一张' }));
    expect(heading('罗盘选站手册')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '第 1 张' }));
    expect(heading('鲸鱼新版评测')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '第 1 张' })).toHaveAttribute('aria-current', 'true');
  });

  it('自动播放，悬停暂停，移开继续', () => {
    vi.useFakeTimers();
    stubApi();
    renderWithProviders(<BannerCarousel banners={banners} />);

    act(() => { vi.advanceTimersByTime(5000); });
    expect(heading('蹬车省钱指南')).toBeInTheDocument();

    const region = screen.getByRole('region', { name: '首页推荐' });
    fireEvent.mouseEnter(region);
    act(() => { vi.advanceTimersByTime(20000); });
    expect(heading('蹬车省钱指南')).toBeInTheDocument();

    fireEvent.mouseLeave(region);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(heading('罗盘选站手册')).toBeInTheDocument();
  });

  it('用户偏好减少动效时不自动播放', () => {
    vi.useFakeTimers();
    stubApi();
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
    renderWithProviders(<BannerCarousel banners={banners} />);
    act(() => { vi.advanceTimersByTime(20000); });
    expect(heading('鲸鱼新版评测')).toBeInTheDocument();
  });

  it('文字由 HTML 叠加，图片靠右裁切并链接到目标', () => {
    stubApi();
    renderWithProviders(<BannerCarousel banners={banners} />);
    expect(screen.getByRole('link', { name: /立即查看/ })).toHaveAttribute('href', '/reviews');
    expect(document.querySelector('img[src="/banners/whale.webp"]')).toHaveClass('banner-image');
  });
});
