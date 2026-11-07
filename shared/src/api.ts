import type {
  Banner, CheckIn, Comment, CommentReply, CommunityRanking, CurrentUser,
  ExpertRanking, FavoriteItem, Model, ModelDetail, ModelRanking, Post, PostKind,
  RankingTab, Station, StationDetail, Target, Vendor, VendorWithModels, VoteSummary, VoteValue,
} from './domain.js';

export interface PaginationQuery {
  page?: number;
  pageSize?: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type SubmissionKind = 'station' | 'model' | 'post';
export type SubmissionChannel = 'feishu' | 'agent' | 'web';
export type SubmissionStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

export interface SubmissionRecord {
  id: string;
  kind: SubmissionKind;
  channel: SubmissionChannel;
  originKey: string;
  payload: unknown;
  actorHandle: string | null;
  status: SubmissionStatus;
  reason: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface ApiErrorResponse {
  error: { code: string; message: string };
}

export type ApiResponse<T> = T | ApiErrorResponse;
export type EmptyRequest = Record<string, never>;
export interface RegisterRequest {
  // 3~20 位字母、数字、下划线，大小写不敏感唯一。
  username: string;
  // 至少 8 位。
  password: string;
  nickname?: string;
}
export type RegisterResponse = CurrentUser;
export interface LoginRequest {
  username: string;
  password: string;
}
export type LoginResponse = CurrentUser;
export type LogoutRequest = EmptyRequest;
export interface LogoutResponse { ok: true }
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}
// 成功后该账号的其他会话全部失效，当前会话保留。
export interface ChangePasswordResponse { ok: true }
// 未登录时 HTTP 401，错误码 UNAUTHENTICATED；我的收藏、我的分享和所有写接口同样如此。
export type GetMeRequest = EmptyRequest;
export type GetMeResponse = CurrentUser;
export interface UpdateMeRequest {
  nickname?: string;
  bio?: string;
}
export type UpdateMeResponse = CurrentUser;
export type CheckInRequest = EmptyRequest;
export interface CheckInResponse extends CheckIn {
  tokens: number;
  checkedInToday: true;
}
export interface AlreadyCheckedInResponse {
  // HTTP 409。
  error: { code: 'ALREADY_CHECKED_IN'; message: string };
}
export type GetMyFavoritesRequest = PaginationQuery;
export type GetMyFavoritesResponse = PaginatedResponse<FavoriteItem>;
export type GetMyPostsRequest = PaginationQuery;
export type GetMyPostsResponse = PaginatedResponse<Post>;
export type GetVendorsRequest = PaginationQuery;
export type GetVendorsResponse = PaginatedResponse<VendorWithModels>;

export interface GetModelsRequest extends PaginationQuery {
  vendor?: string;
  q?: string;
}
export type GetModelsResponse = PaginatedResponse<Model>;
export interface GetModelRequest { slug: string }
export type GetModelResponse = ModelDetail;
export type StationSort = 'score' | 'rate' | 'uptime';
export interface GetStationsRequest extends PaginationQuery {
  vendor?: string;
  sort?: StationSort;
  q?: string;
}
export type GetStationsResponse = PaginatedResponse<Station>;
export interface GetStationRequest { slug: string }
export type GetStationResponse = StationDetail;

export type PostSort = 'latest' | 'hot';
export interface GetPostsRequest extends PaginationQuery {
  kind?: PostKind;
  vendor?: string;
  station?: string;
  model?: string;
  sort?: PostSort;
  q?: string;
}
export type GetPostsResponse = PaginatedResponse<Post>;
export interface GetPostRequest { id: string }
export type GetPostResponse = Post;
export interface CreatePostRequest {
  kind: PostKind;
  title: string;
  summary: string;
  body: string;
  stationSlug?: string;
  modelSlug?: string;
}
export type CreatePostResponse = Post;

export interface PutVoteRequest extends Target { value: VoteValue }
export interface PutVoteResponse extends Target {
  votes: VoteSummary;
  currentUserVote: VoteValue;
}
export interface PutFavoriteRequest extends Target { favorited: boolean }
export interface PutFavoriteResponse extends Target {
  favorited: boolean;
  favoriteCount: number;
}
export interface GetCommentsRequest extends PaginationQuery, Target {}
export type GetCommentsResponse = PaginatedResponse<Comment>;
export interface CreateCommentRequest extends Target {
  // 系统边界校验 1~2000 字；parentId 只能指向顶层评论。
  content: string;
  parentId?: string;
}
export type CreateCommentResponse = Comment | CommentReply;

export interface GetRankingsRequest extends PaginationQuery { tab: RankingTab }
export type GetRankingsResponse =
  | (PaginatedResponse<ModelRanking> & { tab: 'model' })
  | (PaginatedResponse<CommunityRanking> & { tab: 'community' })
  | (PaginatedResponse<ExpertRanking> & { tab: 'expert' });
export type GetBannersRequest = PaginationQuery;
export type GetBannersResponse = PaginatedResponse<Banner>;
export interface SearchRequest { q: string }
export interface SearchResponse {
  // 三组各最多十条，不使用全局分页。
  models: Model[];
  stations: Station[];
  posts: Post[];
}
export type GetHotSearchesRequest = PaginationQuery;
export type GetHotSearchesResponse = PaginatedResponse<string>;

// POST /api/admin/import 的全量导入内容（scripts/sync-feishu.ts → Worker）。
// 这是受保护的运维接口，不属于公开 API，所以不进 ApiContracts 和 API_ROUTES。
export interface CatalogImportStation {
  slug: string;
  name: string;
  description: string;
  url: string;
  rechargeThreshold: number | null;
  paymentMethods: string[];
  offers: { modelSlug: string; rate: number }[];
}
export interface CatalogImportPost {
  recordId: string;
  stationSlug: string;
  title: string;
  summary: string;
  body: string;
  authorName: string;
  publishedAt: string;
}
export interface CatalogImportRequest {
  // 为 true 时，offers 里未收录的 modelSlug 会自动建成待补全的占位模型；默认 false 时仍报错。
  allowNewModels?: boolean;
  stations: CatalogImportStation[];
  posts: CatalogImportPost[];
}
export interface CatalogImportResponse {
  // 内容与上次相同时为 false。
  changed: boolean;
  stations: number;
  offers: number;
  posts: number;
  // 本次自动创建的占位模型 slug，已收录的模型不会重复列出。
  createdModels: string[];
  // 被跳过的站点及原因，例如该站点已由其他通道接管。跳过的站点不会被本接口覆盖。
  // 可选：旧版服务端不返回这个字段，调用方需按缺省空数组处理。
  skipped?: { slug: string; reason: string }[];
}

// POST /api/admin/models。管理接口，同样不进 ApiContracts。
export interface AdminCreateModelRequest {
  slug: string;
  vendor: string;
  name: string;
  description: string;
}
export type AdminCreateModelResponse = Model;

// PATCH /api/admin/models/:slug。slug 是主键不可改，其余可编辑字段都要给全。
export interface AdminUpdateModelRequest {
  vendor: string;
  name: string;
  description: string;
}

// DELETE /api/admin/models/:slug，要求显式确认，避免误删。
export interface AdminDeleteModelRequest { confirm: true }
export interface AdminDeleteModelResponse {
  slug: string;
  deleted: true;
}
// 模型仍被站点报价或文章引用时返回 409，stationCount / postCount 分别是引用它的站点数和文章数。
export interface AdminDeleteModelInUseResponse {
  error: { code: 'MODEL_IN_USE'; message: string; stationCount: number; postCount: number };
}

// POST /api/admin/vendors。管理接口，同样不进 ApiContracts。
export interface AdminCreateVendorRequest {
  slug: string;
  name: string;
  // 缺省等于 slug；前端遇到不认识的图标会降级显示站内图标。
  iconKey?: string;
}
export type AdminCreateVendorResponse = Vendor;

// POST /api/admin/users/:handle/disable。管理接口，同样不进 ApiContracts。
export interface AdminDisableUserRequest { disabled: boolean }
export interface AdminDisableUserResponse {
  handle: string;
  disabled: boolean;
}

export interface ApiContracts {
  register: { request: RegisterRequest; response: ApiResponse<RegisterResponse> };
  login: { request: LoginRequest; response: ApiResponse<LoginResponse> };
  logout: { request: LogoutRequest; response: ApiResponse<LogoutResponse> };
  changePassword: { request: ChangePasswordRequest; response: ApiResponse<ChangePasswordResponse> };
  getMe: { request: GetMeRequest; response: ApiResponse<GetMeResponse> };
  updateMe: { request: UpdateMeRequest; response: ApiResponse<UpdateMeResponse> };
  checkIn: { request: CheckInRequest; response: ApiResponse<CheckInResponse> };
  getMyFavorites: { request: GetMyFavoritesRequest; response: ApiResponse<GetMyFavoritesResponse> };
  getMyPosts: { request: GetMyPostsRequest; response: ApiResponse<GetMyPostsResponse> };
  getVendors: { request: GetVendorsRequest; response: ApiResponse<GetVendorsResponse> };
  getModels: { request: GetModelsRequest; response: ApiResponse<GetModelsResponse> };
  getModel: { request: GetModelRequest; response: ApiResponse<GetModelResponse> };
  getStations: { request: GetStationsRequest; response: ApiResponse<GetStationsResponse> };
  getStation: { request: GetStationRequest; response: ApiResponse<GetStationResponse> };
  getPosts: { request: GetPostsRequest; response: ApiResponse<GetPostsResponse> };
  getPost: { request: GetPostRequest; response: ApiResponse<GetPostResponse> };
  createPost: { request: CreatePostRequest; response: ApiResponse<CreatePostResponse> };
  putVote: { request: PutVoteRequest; response: ApiResponse<PutVoteResponse> };
  putFavorite: { request: PutFavoriteRequest; response: ApiResponse<PutFavoriteResponse> };
  getComments: { request: GetCommentsRequest; response: ApiResponse<GetCommentsResponse> };
  createComment: { request: CreateCommentRequest; response: ApiResponse<CreateCommentResponse> };
  getRankings: { request: GetRankingsRequest; response: ApiResponse<GetRankingsResponse> };
  getBanners: { request: GetBannersRequest; response: ApiResponse<GetBannersResponse> };
  search: { request: SearchRequest; response: ApiResponse<SearchResponse> };
  getHotSearches: { request: GetHotSearchesRequest; response: ApiResponse<GetHotSearchesResponse> };
}
