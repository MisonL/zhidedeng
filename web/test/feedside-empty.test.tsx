import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedSidebar } from '../src/components/Feed';
import { page } from './fixtures';
import { renderWithProviders, stubApi } from './helpers';

/**
 * 新部署的站点还没有审核通过的文章/站点时，首页、社区、评测三页都会挂这个侧栏。
 * 早先 AsyncView 没传 isEmpty 就把 `[]` 当成功数据传下去，children 里的
 * items[0].id 直接抛 TypeError，而 App 没有 error boundary，整棵树被卸载——
 * 三个页面一起白屏。
 */
describe('热门文章空态', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('热门文章与站点都为空时不崩溃', async () => {
    stubApi({
      'GET /api/posts': page([]),
      'GET /api/stations': page([]),
      'GET /api/vendors': page([]),
    });
    renderWithProviders(<FeedSidebar />);
    expect(await screen.findByText('这里还没有内容')).toBeInTheDocument();
  });
});
