import type { AdminSubmissionStateResponse, Post, SubmissionRecord } from '@zhidedeng/shared';

/**
 * 管理接口的独立封装。
 *
 * 这些接口刻意不在公开契约（API_ROUTES）里，用管理密钥而不是登录会话，
 * 所以不走 api.ts。密钥只放 sessionStorage：关掉标签页就没了，
 * 不会像 localStorage 那样在公共机器上长期留存。
 */
const KEY = 'zdd.adminToken';
/** 翻页上限：500 条待审 / 每页 50 = 10 页，留一倍余量。 */
const MAX_PAGES = 20;

export const adminToken = {
  get: () => sessionStorage.getItem(KEY) ?? '',
  set: (value: string) => sessionStorage.setItem(KEY, value),
  clear: () => sessionStorage.removeItem(KEY),
};

export class AdminError extends Error {
  readonly code?: string;
  /** 密钥被拒：调用方要退回输入态，而不是显示一条普通错误。 */
  readonly unauthorized: boolean;

  constructor(message: string, code?: string, unauthorized = false) {
    super(message);
    this.code = code;
    this.unauthorized = unauthorized;
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const token = adminToken.get();
  if (!token) throw new AdminError('请先填写管理密钥', 'NO_TOKEN');
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    signal: init.signal,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }).catch(() => {
    throw new AdminError('网络连接失败，请稍后再试');
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const unauthorized = response.status === 401 || response.status === 403;
    if (unauthorized) adminToken.clear();
    throw new AdminError(payload?.error?.message ?? `请求失败（${response.status}）`, payload?.error?.code, unauthorized);
  }
  return payload as T;
}

export interface PendingSubmissions {
  items: SubmissionRecord[];
  total: number;
}

export interface AdminPostRow {
  id: string;
  kind: Post['kind'];
  title: string;
  summary: string;
  authorHandle: string | null;
  stationSlug: string | null;
  modelSlug: string | null;
  publishedAt: string;
  status: Post['status'];
}

export interface BatchReviewResult {
  id: string;
  /** 服务端逐条独立事务，单条失败不改变 HTTP 状态码，只能从 results 里读。 */
  error?: { status: number; code: string; message: string };
}

export interface RemovedStation {
  slug: string;
  removedAt: string;
}

export const admin = {
  getSubmissionState: (signal?: AbortSignal) => request<AdminSubmissionStateResponse>('/api/admin/submissions/state', { signal }),
  /**
   * 按页取投稿。服务端单页上限 50，批次上限 500，所以必须翻页：
   * 只读第一页会让「全部通过」漏掉其余条目，而界面上看不出来。
   */
  listSubmissions: (status: string, signal?: AbortSignal) =>
    request<PendingSubmissions>(`/api/admin/submissions?status=${encodeURIComponent(status)}&pageSize=50`, { signal }),
  listAllSubmissions: async (status: string, signal?: AbortSignal): Promise<SubmissionRecord[]> => {
    const all: SubmissionRecord[] = [];
    // 页数上限按 total 动态算：写死 20 页（1000 条）时，超出部分被静默丢掉，
    // 「全部通过」会漏条目而界面上完全看不出来。
    let maxPages = MAX_PAGES;
    for (let page = 1; page <= maxPages; page += 1) {
      const chunk = await request<PendingSubmissions>(
        `/api/admin/submissions?status=${encodeURIComponent(status)}&pageSize=50&page=${page}`, { signal },
      );
      if (page === 1) maxPages = Math.max(maxPages, Math.ceil(chunk.total / 50));
      all.push(...chunk.items);
      if (all.length >= chunk.total || chunk.items.length === 0) return all;
    }
    // 到上限还没取完：宁可报错，也不能假装取全了。
    throw new AdminError(`待审条目过多（超过 ${all.length} 条），请先分批处理`, 'TOO_MANY');
  },
  reviewSubmission: (id: string, status: 'approved' | 'rejected', reason?: string) =>
    request<SubmissionRecord>(`/api/admin/submissions/${encodeURIComponent(id)}/review`, {
      method: 'POST', body: { status, ...(reason ? { reason } : {}) },
    }),
  batchReview: (ids: string[], status: 'approved' | 'rejected', reason?: string) =>
    request<{ results: BatchReviewResult[] }>('/api/admin/submissions/batch-review', {
      method: 'POST', body: { ids, status, ...(reason ? { reason } : {}) },
    }),
  listPosts: (status: string, signal?: AbortSignal) =>
    request<{ items: AdminPostRow[] }>(`/api/admin/posts?status=${encodeURIComponent(status)}`, { signal }),
  reviewPost: (id: string, status: 'approved' | 'rejected') =>
    request<{ id: string; status: string }>(`/api/admin/posts/${encodeURIComponent(id)}/review`, { method: 'POST', body: { status } }),
  listRemovedStations: (signal?: AbortSignal) => request<{ items: RemovedStation[] }>('/api/admin/stations/removed', { signal }),
  restoreStation: (slug: string) =>
    request<{ slug: string; restored: true }>(`/api/admin/stations/${encodeURIComponent(slug)}/restore`, { method: 'POST', body: {} }),
};
