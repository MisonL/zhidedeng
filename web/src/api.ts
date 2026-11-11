import { API_ROUTES } from '@zhidedeng/shared';
import type {
  ApiContracts, ApiErrorResponse, ApiRouteName, ChangePasswordRequest, CreateAgentTokenRequest, CreateCommentRequest, CreatePostRequest,
  GetModelsRequest, GetPostsRequest, GetRankingsRequest, GetStationsRequest, LoginRequest, PaginationQuery,
  PutFavoriteRequest, PutVoteRequest, RegisterRequest, SuggestModelRequest, Target, UpdateMeRequest,
} from '@zhidedeng/shared';

export class ApiError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

type Ok<N extends ApiRouteName> = Exclude<ApiContracts[N]['response'], ApiErrorResponse>;

interface CallOptions {
  path?: Record<string, string>;
  query?: object;
  body?: unknown;
  signal?: AbortSignal;
}

function buildUrl(template: string, { path, query }: CallOptions) {
  const url = template.replace(/:(\w+)/, (_, key: string) => encodeURIComponent(path![key]));
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${url}?${search}` : url;
}

async function call<N extends ApiRouteName>(name: N, options: CallOptions = {}): Promise<Ok<N>> {
  const route = API_ROUTES[name];
  const response = await fetch(buildUrl(route.path, options), {
    method: route.method,
    signal: options.signal,
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }).catch(() => {
    throw new ApiError('网络连接失败，请稍后再试');
  });
  // 代理在后端未就绪时会返回非 JSON 响应。
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload?.error?.message ?? `请求失败（${response.status}）`, payload?.error?.code);
  }
  return payload;
}

export const api = {
  register: (body: RegisterRequest) => call('register', { body }),
  login: (body: LoginRequest) => call('login', { body }),
  logout: () => call('logout', { body: {} }),
  changePassword: (body: ChangePasswordRequest) => call('changePassword', { body }),
  createAgentToken: (body: CreateAgentTokenRequest) => call('createAgentToken', { body }),
  getAgentTokens: (signal?: AbortSignal) => call('getAgentTokens', { signal }),
  revokeAgentToken: (id: string) => call('revokeAgentToken', { path: { id }, body: {} }),
  getMe: (signal?: AbortSignal) => call('getMe', { signal }),
  updateMe: (body: UpdateMeRequest) => call('updateMe', { body }),
  checkIn: () => call('checkIn', { body: {} }),
  getMyFavorites: (query: PaginationQuery, signal?: AbortSignal) => call('getMyFavorites', { query, signal }),
  getMyPosts: (query: PaginationQuery, signal?: AbortSignal) => call('getMyPosts', { query, signal }),
  getVendors: (signal?: AbortSignal) => call('getVendors', { query: { pageSize: 50 }, signal }),
  getModels: (query: GetModelsRequest, signal?: AbortSignal) => call('getModels', { query, signal }),
  getModel: (slug: string, signal?: AbortSignal) => call('getModel', { path: { slug }, signal }),
  getStations: (query: GetStationsRequest, signal?: AbortSignal) => call('getStations', { query, signal }),
  getStation: (slug: string, signal?: AbortSignal) => call('getStation', { path: { slug }, signal }),
  getPosts: (query: GetPostsRequest, signal?: AbortSignal) => call('getPosts', { query, signal }),
  getPost: (id: string, signal?: AbortSignal) => call('getPost', { path: { id }, signal }),
  createPost: (body: CreatePostRequest) => call('createPost', { body }),
  suggestModel: (body: SuggestModelRequest) => call('suggestModel', { body }),
  putVote: (body: PutVoteRequest) => call('putVote', { body }),
  putFavorite: (body: PutFavoriteRequest) => call('putFavorite', { body }),
  getComments: (query: Target & PaginationQuery, signal?: AbortSignal) => call('getComments', { query, signal }),
  createComment: (body: CreateCommentRequest) => call('createComment', { body }),
  getRankings: (query: GetRankingsRequest, signal?: AbortSignal) => call('getRankings', { query, signal }),
  getBanners: (signal?: AbortSignal) => call('getBanners', { signal }),
  search: (q: string, signal?: AbortSignal) => call('search', { query: { q }, signal }),
  getHotSearches: (signal?: AbortSignal) => call('getHotSearches', { signal }),
};
