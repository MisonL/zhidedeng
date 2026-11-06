import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModelTile, VendorIcon } from '../src/components/visuals';
import { page } from './fixtures';
import { renderWithProviders, stubApi } from './helpers';

const FALLBACK = '/favicon.svg';

describe('厂商图标兜底', () => {
  it('未知 iconKey 降级为站内图标，不会抛错', () => {
    const { container } = render(<VendorIcon iconKey="brand-new-vendor" size={24} />);
    expect(container.querySelector('img')!.getAttribute('src')).toBe(FALLBACK);
  });

  it('已有 iconKey 仍用厂商图标', () => {
    const { container } = render(<VendorIcon iconKey="openai" />);
    expect(container.querySelector('img')!.getAttribute('src')).not.toBe(FALLBACK);
  });

  it('新增厂商的模型封面用兜底图标和底色，不崩', async () => {
    stubApi({
      'GET /api/vendors': page([{ slug: 'stepfun', name: '阶跃星辰', iconKey: 'stepfun', models: [{ slug: 'step-2', vendor: 'stepfun', name: 'Step 2', description: '新厂商模型', tags: [] }] }]),
      'GET /api/stations': page([]),
    });
    const { container } = renderWithProviders(<ModelTile model={{ vendor: 'stepfun', name: 'Step 2' }} />);
    // 厂商目录是异步加载的，等封面拿到厂商后的兜底徽章出现。
    await waitFor(() => expect(container.querySelector('.cover-badge img')!.getAttribute('src')).toBe(FALLBACK));
    expect(container.querySelector('.cover-model')).toBeInTheDocument();
  });
});
