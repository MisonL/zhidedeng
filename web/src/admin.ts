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

/** 与公开接口一致：没有超时时，后端不响应会让按钮永远转圈。 */
const ADMIN_TIMEOUT_MS = 30_000;

async function request<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const token = adminToken.get();
  if (!token) throw new AdminError('请先填写管理密钥', 'NO_TOKEN');
  // 批量审核一次要发 100 个 id，给的时间比普通请求宽。
  const timeout = AbortSignal.timeout(ADMIN_TIMEOUT_MS);
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }).catch((error: unknown) => {
    if (timeout.aborted && !init.signal?.aborted) throw new AdminError('请求超时，请稍后重试', 'TIMEOUT');
    throw new AdminError(error instanceof Error && error.name === 'AbortError' ? '请求已取消' : '网络连接失败，请稍后再试');
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const unauthorized = response.status === 401 || response.status === 403;
    if (unauthorized) adminToken.clear();
    // 404 在这里几乎总是「nginx 把 /api/admin/ 挡了」，而不是接口真的不存在。
    // 不解释的话，运维只会看到「请求失败（404）」然后去翻后端日志。
    const message = response.status === 404
      ? '管理接口未对公网开放。请从服务器本机访问，或先建 SSH 隧道：ssh -L 8787:127.0.0.1:8787 <主机>，然后打开 http://127.0.0.1:8787/admin'
      : payload?.error?.message ?? `请求失败（${response.status}）`;
    throw new AdminError(message, payload?.error?.code, unauthorized);
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
  /** 非空表示这一条是「某篇文章的新版本」，不是一篇新文章。 */
  editOf?: string | null;
  /** 被修改的那篇文章当前的标题，给审核员认人用。 */
  targetTitle?: string | null;
  /** 相对线上版本变了哪几个字段（标题/摘要/正文/关联项）。 */
  changedFields?: string[];
  /** 正文：审核台要能展开看全文，不能只凭标题摘要点通过。 */
  body?: string;
  /** 文章当前是第几版。>1 才有「撤销上次修改」可言。 */
  contentVersion?: number;
}

export interface AdminDeletedAccount {
  handle: string;
  createdAt: string;
  deletedAt: string;
  postCount: number;
}

export interface AdminReport {
  id: string;
  targetType: 'post' | 'station' | 'comment';
  targetId: string;
  reporterHandle: string;
  reason: string;
  detail: string | null;
  status: 'open' | 'resolved' | 'dismissed';
  createdAt: string;
  handledAt: string | null;
  targetAlive: boolean;
  targetLabel: string;
  /** 举报那一刻文章是第几版；与 currentVersion 不同说明内容已经改过。 */
  targetVersion: number | null;
  currentVersion: number | null;
}

export interface BatchReviewResult {
  id: string;
 /**审核后的状态：approved/rejected/superseded（被同批其他版本替代，不算失败）。只回这两个字段，不回整条记录（500条时那是295KB 的无用载荷）。 */
  status?: string;
  /** 服务端写入的审核理由，例如「站点已不存在，视为已下架」。 */
  reason?: string | null;
  /** 服务端逐条独立事务，单条失败不改变 HTTP 状态码，只能从 results 里读。 */
  error?: { status: number; code: string; message: string };
}

export interface RemovedStation {
  slug: string;
  removedAt: string;
  /** 站名：只给 slug 的话，误下架后认不出是哪个站。 */
  name: string;
  url: string | null;
  /** 是否有可退回的上一版投稿快照（没有就别显示按钮，免得点下去 409）。 */
  hasRevert: boolean;
}
/** 已下架的文章。和站点不同，文章没有 slug，用 id 指代。 */
export interface RemovedPost {
  id: string;
  removedAt: string;
  /** 标题：只给 id 的话，误下架后管理员认不出该恢复哪一篇。 */
  title: string;
  authorHandle: string | null;
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
  // 隐藏/恢复一条评论。举报页签里直接处置评论：原来只能下架整篇文章，
  // 而「一条评论有问题」最常见，处置手段不该比问题本身更重。
  hideComment: (id: string, hidden: boolean) =>
    request<{ id: string; hidden: boolean }>(`/api/admin/comments/${encodeURIComponent(id)}/hide`, { method: 'POST', body: { hidden } }),
  // 禁用/恢复一个账号（禁用后所有会话立即失效，公开内容保留）。
  setUserDisabled: (handle: string, disabled: boolean) =>
    request<{ handle: string; disabled: boolean }>(`/api/admin/users/${encodeURIComponent(handle)}/disable`, { method: 'POST', body: { disabled } }),
  // 撤销最近一次站点投稿上线：整包替换不可逆，误批会删掉报价历史。
  revertStation: (slug: string) =>
    request<{ slug: string; restoredName: string; offerCount: number }>(`/api/admin/stations/${encodeURIComponent(slug)}/revert`, { method: 'POST' }),
  // 撤销最近一次编辑上线：误批之后退回上一版，而不是只能下架。
  revertRevision: (id: string) =>
    request<{ postId: string; restoredVersion: number; title: string }>(`/api/admin/posts/${encodeURIComponent(id)}/revert`, { method: 'POST' }),
  // 已注销账号：只读列表 + 恢复。管理员不能代用户注销（没有可代持的凭据）。
  listDeletedAccounts: (signal?: AbortSignal) =>
    request<{ items: AdminDeletedAccount[] }>('/api/admin/accounts/deleted', { signal }),
  restoreAccount: (handle: string) =>
    request<{ handle: string; restored: true }>(`/api/admin/accounts/${encodeURIComponent(handle)}/restore`, { method: 'POST' }),
  // 加减 Token：理由必填（流水就是审计日志）。
  adjustTokens: (handle: string, delta: number, memo: string) =>
    request<{ handle: string; balance: number }>(`/api/admin/accounts/${encodeURIComponent(handle)}/tokens`, {
      method: 'POST', body: { delta, memo },
    }),
  listPosts: (status: string, signal?: AbortSignal) =>
    request<{ items: AdminPostRow[] }>(`/api/admin/posts?status=${encodeURIComponent(status)}`, { signal }),
  // 拒绝必须带理由，与服务端的强制校验保持一致（不带会被 400 挡回来）。
  reviewPost: (id: string, status: 'approved' | 'rejected', reason?: string) =>
    request<{ id: string; status: string }>(`/api/admin/posts/${encodeURIComponent(id)}/review`, {
      method: 'POST', body: { status, ...(reason ? { reason } : {}) },
    }),
  // 已发布文章的撤回与恢复。撤回是软删除，正文一直留着，误操作能直接救回来。
  withdrawPost: (id: string) =>
    request<{ id: string; removed: true }>(`/api/admin/posts/${encodeURIComponent(id)}/withdraw`, { method: 'POST', body: {} }),
  restorePost: (id: string) =>
    request<{ id: string; restored: true }>(`/api/admin/posts/${encodeURIComponent(id)}/restore`, { method: 'POST', body: {} }),
  listRemovedPosts: (signal?: AbortSignal) => request<{ items: RemovedPost[] }>('/api/admin/posts/removed', { signal }),
  listReports: (status: string, pageSize: number, cursor: string | null, signal?: AbortSignal) =>
    request<{ items: AdminReport[]; total: number; pageSize: number; nextCursor: string | null }>(
      `/api/admin/reports?status=${encodeURIComponent(status)}&pageSize=${pageSize}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      { signal },
    ),
  resolveReport: (id: string, status: 'resolved' | 'dismissed', note?: string) =>
    request<{ id: string; status: string }>(`/api/admin/reports/${encodeURIComponent(id)}/resolve`, {
      method: 'POST', body: { status, ...(note ? { note } : {}) },
    }),
  listRemovedStations: (signal?: AbortSignal) => request<{ items: RemovedStation[] }>('/api/admin/stations/removed', { signal }),
  restoreStation: (slug: string) =>
    request<{ slug: string; restored: true }>(`/api/admin/stations/${encodeURIComponent(slug)}/restore`, { method: 'POST', body: {} }),
};
