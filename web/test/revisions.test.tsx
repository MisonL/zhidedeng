import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { callsTo, renderApp, stubApi } from './helpers';
import { makePost } from './fixtures';


describe('撤回修改需要二次确认', () => {
  it('点「撤回修改」先追问，确认后才发 DELETE', async () => {
    const fetchMock = stubApi({
      'GET /api/posts/p1': makePost('p1', { title: '我的文章', status: 'approved' }),
      'GET /api/posts/p1/revision': {
        revision: { id: 'r1', status: 'pending', submittedAt: '2026-11-24T00:00:00.000Z', reviewReason: null, payload: {} },
      },
      'DELETE /api/posts/p1/revision': { ok: true },
    });
    renderApp('/posts/p1/edit');
    // 撤回会把正在审核的那一版直接丢掉；站内其它破坏性操作都二次确认，这里也要。
    fireEvent.click(await screen.findByRole('button', { name: '撤回修改' }, { timeout: 8000 }));
    expect(callsTo(fetchMock, 'DELETE', '/api/posts/p1/revision')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '确认撤回' }));
    await waitFor(() => expect(callsTo(fetchMock, 'DELETE', '/api/posts/p1/revision')).toHaveLength(1));
  });
});
