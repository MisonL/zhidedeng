import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callsTo, deferred, renderApp, stubApi } from './helpers';
import { makePost } from './fixtures';

// 不用 vi.mock：这个仓库的 vitest 跑在 --no-isolate 下，模块 mock 会跨文件泄漏，
// 别处的 useCatalog 会被换成本文件里的空实现。统一走 stubApi 打桩 fetch。

const live = makePost('p1', {
  kind: 'community', title: '线上标题', summary: '线上摘要', body: '线上正文',
  author: { handle: 'demo-pedal', nickname: '虚构踏板', avatar: '' }, source: 'user',
  contentVersion: 2, revisedAt: null,
});

describe('编辑已发布文章页', () => {
  let fetchMock: ReturnType<typeof stubApi>;
  beforeEach(() => {
    fetchMock = stubApi({
      'GET /api/posts/p1': live,
      'GET /api/posts/p1/revision': { revision: null },
    });
  });

  const edit = async () => {
    renderApp('/posts/p1/edit');
    await waitFor(() => expect(screen.getByLabelText('标题')).toBeTruthy());
  };

  it('没有修改时预填线上版，并显示当前版本号', async () => {
    await edit();
    await waitFor(() => expect(screen.getByLabelText('标题')).toHaveValue('线上标题'));
    expect(screen.getByText(/当前版本第 2 版/)).toBeTruthy();
  });

  it('文章详情先返回、修改后返回时，仍然预填被拒那一版（预填竞态）', async () => {
    // 正常网络顺序就是详情先到。只等 post 就灌值的话，被拒那版永远进不来，
    // 而 banner 还写着「下面预填的是被拒的那一版」。
    const slowRevision = deferred<unknown>();
    fetchMock = stubApi({
      'GET /api/posts/p1': live,
      'GET /api/posts/p1/revision': () => slowRevision.promise,
    });
    renderApp('/posts/p1/edit');
    // 先让详情的那一轮渲染跑完。
    await waitFor(() => expect(screen.getByText('编辑文章')).toBeTruthy());
    slowRevision.resolve({
      revision: {
        submissionId: 's1', status: 'rejected', reviewReason: '写得不行',
        submittedAt: '2026-11-02T00:00:00.000Z',
        payload: { kind: 'community', title: '被拒的标题', summary: '被拒摘要', body: '被拒正文', stationSlug: null, modelSlug: null },
      },
    });
    await waitFor(() => expect(screen.getByLabelText('标题')).toHaveValue('被拒的标题'));
    expect(screen.getByLabelText(/^正文/)).toHaveValue('被拒正文');
  });

  it('被拒时预填被拒那一版，不是线上版', async () => {
    fetchMock = stubApi({
      'GET /api/posts/p1': live,
      'GET /api/posts/p1/revision': {
        revision: {
          submissionId: 's1', status: 'rejected', reviewReason: '正文里写了绝对价格',
          submittedAt: '2026-11-02T00:00:00.000Z',
          payload: { kind: 'community', title: '被拒的标题', summary: '被拒摘要', body: '被拒正文', stationSlug: null, modelSlug: null },
        },
      },
    });
    await edit();
    await waitFor(() => expect(screen.getByLabelText('标题')).toHaveValue('被拒的标题'));
    expect(screen.getByLabelText('摘要')).toHaveValue('被拒摘要');
    // 线上版的内容一个都不该出现在表单里——预填线上版等于让作者白改一遍。
    expect(screen.getByLabelText(/^正文/)).not.toHaveValue('线上正文');
    expect(screen.getByText(/正文里写了绝对价格/)).toBeTruthy();
  });

  it('待审修改还在时禁用提交并给撤回入口', async () => {
    fetchMock = stubApi({
      'GET /api/posts/p1': live,
      'GET /api/posts/p1/revision': {
        revision: {
          submissionId: 's2', status: 'pending', reviewReason: null, submittedAt: '2026-11-03T00:00:00.000Z',
          payload: { kind: 'community', title: '待审标题', summary: 's', body: 'b', stationSlug: null, modelSlug: null },
        },
      },
    });
    await edit();
    await waitFor(() => expect(screen.getByText(/已有一版修改在审核中/)).toBeTruthy());
    expect(screen.getByRole('button', { name: '有一版在审核中' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '撤回修改' })).toBeTruthy();
  });

  it('提交时带上打开编辑器看到的版本号，成功后回到文章页', async () => {
    fetchMock = stubApi({
      'GET /api/posts/p1': live,
      'GET /api/posts/p1/revision': { revision: null },
      'PUT /api/posts/p1/revision': { postId: 'p1', submissionId: 's9', status: 'pending', submittedAt: '2026-11-09T00:00:00.000Z' },
    });
    await edit();
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '改过的标题' } });
    fireEvent.click(screen.getByRole('button', { name: '提交修改' }));

    await waitFor(() => expect(callsTo(fetchMock, 'PUT', '/api/posts/p1/revision')).toHaveLength(1));
    // baseVersion 必须是详情页读到的 2，不是硬编码的 1：它决定服务端要不要拒
    // 「你基于旧版本写的」。
    expect(callsTo(fetchMock, 'PUT', '/api/posts/p1/revision')[0].body).toMatchObject({
      id: 'p1', title: '改过的标题', baseVersion: 2,
    });
  });

  it('别人的文章不给编辑入口', async () => {
    // 作者是别人（不是当前登录的 demo-pedal）。
    fetchMock = stubApi({ 'GET /api/posts/p1': makePost('p1', { source: 'user', author: { handle: 'someone-else', nickname: '别人', avatar: '' } }), 'GET /api/posts/p1/revision': { revision: null } });
    renderApp('/posts/p1/edit');
    await waitFor(() => expect(screen.getByText('只能编辑自己的文章')).toBeTruthy());
  });
});
