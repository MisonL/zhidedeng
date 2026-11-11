import type { AdminSubmissionStateResponse, Post, SubmissionRecord } from '@zhidedeng/shared';

/**
 * 管理接口的独立封装。
 *
 * 这些接口刻意不在公开契约（API_ROUTES）里，用管理密钥而不是登录会话，
 * 所以不走 api.ts。密钥只放 sessionStorage：关掉标签页就没了，
 * 不会像 localStorage 那样在公共机器上长期留存。
 */
const KEY = 'zdd.adminToken';

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

export interface RemovedStation {
  slug: string;
  removedAt: string;
}

export const admin = {
  getSubmissionState: (signal?: AbortSignal) => request<AdminSubmissionStateResponse>('/api/admin/submissions/state', { signal }),
  listSubmissions: (status: string, signal?: AbortSignal) =>
    request<PendingSubmissions>(`/api/admin/submissions?status=${encodeURIComponent(status)}&pageSize=50`, { signal }),
  reviewSubmission: (id: string, status: 'approved' | 'rejected', reason?: string) =>
    request<SubmissionRecord>(`/api/admin/submissions/${encodeURIComponent(id)}/review`, {
      method: 'POST', body: { status, ...(reason ? { reason } : {}) },
    }),
  batchReview: (ids: string[], status: 'approved' | 'rejected', reason?: string) =>
    request<{ results: unknown[] }>('/api/admin/submissions/batch-review', {
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
