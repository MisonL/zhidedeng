import type {
  AgentToken, Author, Banner, CheckIn, Comment, CommentReply, CommunityRanking, CurrentUser,
  ExpertRanking, FavoriteItem, Model, ModelDetail, ModelRanking, Post, PostKind, PostSummary, StationRanking,
  ISODate, ISODateTime, RankingTab, RateBasis, Station, StationDetail, Target, Vendor, VendorWithModels, VoteSummary, VoteValue,
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
  batchId: string | null;
  action: 'upsert' | 'remove';
  payload: unknown;
  actorHandle: string | null;
  status: SubmissionStatus;
  reason: string | null;
  createdAt: string;
  reviewedAt: string | null;
  /** 编辑已发布文章时指向目标文章；普通投稿为 null。 */
  targetPostId?: string | null;
  /** 提交修改时作者看到的版本号，用于发现「审核期间又上线了新版」。 */
  baseVersion?: number | null;
}

// POST /api/admin/submissions/batch。管理接口，不进公开契约。
export interface AdminBatchSubmitRequest {
  channel: SubmissionChannel;
  // 不传时由服务端生成。
  batchId?: string;
  items: {
    kind: SubmissionKind;
    originKey: string;
    payload: unknown;
    actorHandle?: string | null;
    action?: 'upsert' | 'remove';
  }[];
}
export interface AdminBatchSubmitResponse {
  batchId: string;
  results: {
    originKey: string;
    kind: SubmissionKind;
    id?: string;
    status?: SubmissionStatus;
    /** 审核/物化留下的原因，例如「此前已被下架，本次同步跳过」。 */
    reason?: string | null;
    deduplicated?: boolean;
    autoApproved?: boolean;
    error?: { code: string; message: string };
  }[];
}

// GET /api/admin/submissions/state。只供同步脚本比较已上线的队列站点。
export interface InviteCode {
  id: string;
  codePrefix: string;
  note: string | null;
  /** null 表示不限次数。 */
  maxUses: number | null;
  usedCount: number;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreateInviteCodeRequest {
  note?: string;
  maxUses?: number | null;
  expiresAt?: string | null;
}

export interface CreateInviteCodeResponse {
  /** 明文只在这里返回一次，库里只有哈希。 */
  code: string;
  inviteCode: InviteCode;
}

export interface GetInviteCodesRequest { }

export interface GetInviteCodesResponse {
  items: InviteCode[];
}

export interface RevokeInviteCodeRequest { }

export interface RevokeInviteCodeResponse {
  inviteCode: InviteCode;
}

export interface AdminSubmissionStateResponse {
  stations: { slug: string; submissionId: string; originKey: string; url: string | null; name: string }[];
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
export interface CreateAgentTokenRequest {
  label: string;
  inviteCode?: string;
}
// 明文只在本次签发返回，之后列表只能读到展示前缀。
export type CreateAgentTokenResponse = Pick<AgentToken, 'id' | 'tokenPrefix' | 'label' | 'createdAt'> & { token: string };
export type GetAgentTokensRequest = EmptyRequest;
export type GetAgentTokensResponse = AgentToken[];
export type ReportTargetType = 'post' | 'station' | 'comment';
export type ReportStatus = 'open' | 'resolved' | 'dismissed';

export interface CreateReportRequest {
  targetType: ReportTargetType;
  targetId: string;
  /** 一句原因。前端给固定选项，也允许自由填写。 */
  reason: string;
  /** 补充说明，可选。 */
  detail?: string;
}
export interface CreateReportResponse {
  id: string;
  status: ReportStatus;
}

/**
 * 编辑已发布文章。**旧版本继续在线**，改动进审核队列；通过才切换。
 *
 * `baseVersion` 是作者打开编辑器时看到的 contentVersion：审核期间别人（或自己
 * 在另一个标签页）又提交并上线了一版时，这条修改就不再是最新的，必须让作者
 * 重新基于新版改，否则会把别人的改动覆盖掉。
 */
export interface SubmitRevisionRequest {
  id: string;
  kind: PostKind;
  title: string;
  summary: string;
  body: string;
  stationSlug?: string | null;
  modelSlug?: string | null;
  baseVersion: number;
}
export interface SubmitRevisionResponse {
  postId: string;
  submissionId: string;
  status: 'pending';
  submittedAt: string;
}
/** 作者读自己那一版待审/被拒的修改，用来回填编辑器。 */
export interface GetRevisionRequest { id: string }
export interface RevisionView {
  submissionId: string;
  status: 'pending' | 'rejected';
  payload: { kind: PostKind; title: string; summary: string; body: string; stationSlug: string | null; modelSlug: string | null };
  submittedAt: string;
  reviewReason: string | null;
}
export interface GetRevisionResponse { revision: RevisionView | null }
export interface WithdrawRevisionRequest { id: string }
export interface WithdrawRevisionResponse { id: string; withdrawn: true }

/**
 * 注销账号。**软注销**：账号行保留（用户名永久占用）、个人资料与偏好清空、
 * 内容保留但署名降级为「已注销用户·handle」。
 *
 * 不用 DELETE 方法：CSRF 闸门对无正文的 DELETE 不读 body，带不了二次口令。
 * 二次确认要口令 + 确认短语两个，缺一个都不够——注销不可撤销（恢复只给管理员）。
 */
export interface DeleteAccountRequest {
  password: string;
  /** 必须是「注销」二字，防误触。 */
  confirm: string;
}
export interface DeleteAccountResponse { ok: true; deletedAt: string }

/**
 * Token 消耗。只卖「不影响内容准入」的东西：送花、徽章、导出自己的数据、补签。
 * 买排名/审核/举报优先这类一律不做——能买就不再是真实体验。
 */
export interface TokenShopItem {
  key: string;
  name: string;
  cost: number;
  unit: string;
  description: string;
  /** 每自然月的次数上限（上海时区）。 */
  monthlyLimit: number;
  /** 每自然日的次数上限，未设则不限制。 */
  dailyLimit?: number;
  /** 兑换时必须带 targetId 的话，这里说明目标是什么。 */
  requiresTarget: 'post' | 'date' | null;
}

export interface TokenLedgerEntry {
  id: string;
  handle: string;
  /** 正数为收入，负数为支出。 */
  delta: number;
  balanceAfter: number;
  reason: 'signup' | 'checkin' | 'redeem' | 'admin_grant' | 'admin_deduct' | 'refund';
  memo: string | null;
  at: string;
}

export interface TokenRedemption {
  id: string;
  itemKey: string;
  cost: number;
  targetType: string | null;
  targetId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface GetMyTokensRequest { [key: string]: never }
export interface GetMyTokensResponse {
  balance: number;
  earned: number;
  spent: number;
  items: TokenShopItem[];
  /** 已获得的持久权益（例如徽章）。 */
  entitlements: string[];
  /** 各项目本自然月已用次数，key 是 itemKey。 */
  usedThisMonth: Record<string, number>;
}

export interface GetTokenLedgerRequest {
  page?: number;
  pageSize?: number;
}
export interface GetTokenLedgerResponse {
  items: TokenLedgerEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RedeemTokensRequest {
  itemKey: string;
  /** 客户端生成，重试同一个键返回同一张单，不会扣两次。 */
  idempotencyKey: string;
  targetId?: string;
}
export interface RedeemTokensResponse {
  order: TokenRedemption;
  balance: number;
}

export interface DeletePostRequest { id: string }
export interface DeletePostResponse { id: string; removed: true }

export interface DeleteCommentRequest { id: string }
export interface DeleteCommentResponse { id: string; deleted: 'removed' | 'tombstoned' }

export interface RevokeAgentTokenRequest { id: string }
export interface RevokeAgentTokenResponse { id: string; revokedAt: string }

// Agent 提交直接接收投稿 payload，不接受 channel、actorHandle、batchId 或审核字段。
export interface CreateAgentStationRequest {
  name: string;
  description: string;
  url: string;
  rechargeThreshold: number | null;
  paymentMethods: string[];
  offers: { modelSlug: string; rate: number; basis?: RateBasis; quotedAt?: ISODateTime | null }[];
}
export interface CreateAgentPostRequest {
  title: string;
  summary: string;
  body: string;
  authorName: string;
  hostname?: string | null;
  publishedAt?: string | null;
}
export interface AgentSubmitResponse {
  submission: SubmissionRecord;
  deduplicated: boolean;
  // 管理员开启自动通过时为 true，此时 submission.status 已经是 approved。
  autoApproved: boolean;
}
// 补录模型：vendor 必须是已有厂商，slug 已存在时服务端返回 409 MODEL_EXISTS。
export interface CreateAgentModelRequest {
  slug: string;
  vendor: string;
  name: string;
  description: string;
}
export type CreateAgentStationResponse = AgentSubmitResponse;
export type CreateAgentPostResponse = AgentSubmitResponse;
export type CreateAgentModelResponse = AgentSubmitResponse;
// 站内补录模型：和 Agent 通道同一套字段，走 web 渠道进同一个队列。
export interface SuggestModelRequest {
  slug: string;
  vendor: string;
  name: string;
  description: string;
}
/** 模型补录没有文章实体可回，返回入队结果即可。 */
export interface SuggestModelResponse {
  id: string;
  slug: string;
  status: SubmissionStatus;
  deduplicated: boolean;
}
/**
 * 推荐一个新中转站。
 *
 * 在这之前站内用户**根本无法推荐站点**：网页投稿只有文章和补录模型两种，
 * 站点只能由飞书同步或 Agent 送来。结果是站点供给完全依赖外部通道——
 * 一个刚开的中转站读者无从提交，站方也收不到任何信号。
 *
 * 字段取「知道多少填多少」：网址必填（站点身份由 hostname 决定），
 * 名称必填，报价、最低充值、支付方式都是可选的。管理员审核时再补全，
 * 与飞书同步走同一个投稿队列和同一套物化逻辑。
 */
export interface SuggestStationRequest {
  name: string;
  url: string;
  description?: string;
  /** 每行一个「模型slug=倍率」，由前端拆分后按模型提交。 */
  offers?: { modelSlug: string; rate: number; basis?: RateBasis; quotedAt?: ISODateTime | null }[];
  rechargeThreshold?: number | null;
  paymentMethods?: string[];
}
/** 站点推荐同样没有实体可回，返回入队结果。 */
export interface SuggestStationResponse {
  id: string;
  status: SubmissionStatus;
  deduplicated: boolean;
}
export interface GetAgentStatusRequest {
  // 默认最近 20 条，最多 50 条。
  limit?: number;
}
export interface AgentPendingQuota { limit: number; remaining: number }
export interface AgentRateQuota extends AgentPendingQuota { retryAfter: number }
export interface GetAgentStatusResponse {
  handle: string;
  pendingCount: number;
  quotas: {
    token: AgentRateQuota;
    account: AgentRateQuota;
    ip: AgentRateQuota;
    pending: AgentPendingQuota;
    globalPending: AgentPendingQuota;
    // 本人待审内容涉及的 hostname；remaining 计入所有渠道关联该 hostname 的待审记录。
    hostnames: (AgentPendingQuota & { hostname: string; pendingCount: number })[];
  };
  // originKey 必须带上：批量提交后收到一条 rejected + 理由「报价不准确」，
  // 只有 id 的话提交方（尤其 Agent）不知道被拒的是哪个站。
  submissions: Pick<SubmissionRecord, 'id' | 'kind' | 'status' | 'createdAt' | 'reason' | 'originKey'>[];
}
// 未登录时 HTTP 401，错误码 UNAUTHENTICATED；我的收藏、我的分享和所有写接口同样如此。
export type GetMeRequest = EmptyRequest;
export type GetMeResponse = CurrentUser;
export interface UpdateMeRequest {
  nickname?: string;
  bio?: string;
  /** 预设头像标识，取值见 shared/domain 的 AVATAR_PRESETS。空串 = 默认。 */
  avatar?: string;
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

/**
 * 「我的投稿」的一条记录，覆盖文章、模型、站点三类。
 *
 * `getMyPosts` 只返回文章，作者补录了模型或推荐了站点就查不到结果——
 * 那两条通道有自己的审核流程和驳回理由，但提交人在站内看不到任何反馈。
 */
export interface MySubmission {
  id: string;
  kind: 'station' | 'model' | 'post';
  status: SubmissionStatus;
  /**
   * 已通过、但当前不在线上（最常见的是作者自己撤下了，或管理员下架）。
   *
   * 没有这个字段时，「我的投稿」只能显示「已通过」却不给链接——作者刚撤下
   * 一篇文章，回头看到的是「已通过」，会以为撤下没生效。
   */
  withdrawn?: boolean;
  /** 驳回理由；通过或待审时为 null。 */
  reason: string | null;
  /** 人可读的标题：文章取标题，模型取名称，站点取站名。 */
  title: string;
  createdAt: ISODateTime;
  reviewedAt: ISODateTime | null;
  /** 已通过时指向物化后的实体，方便前端给出去看它的链接。 */
  targetSlug: string | null;
}
export type GetMySubmissionsResponse = PaginatedResponse<MySubmission>;

/**
 * 站内通知。只做本人相关的事件，**拉模型**：没有推送、没有未读红点计数。
 *
 * 不做未读数是因为它需要客户端轮询或长连接，而本站的节奏是「来看的时候顺便看看」；
 * 搞一个永远 0 或永远滞后的小红点，比没有更糟。
 */
export interface NotificationItem {
  /**
   * 稳定 id，由来源表的主键派生（`submission:<id>` / `report:<id>` / `post:<流水主键>` / `flower:<兑换单>`）。
   * 前端只拿它当 React key，不做业务判断。
   */
  id: string;
  kind: 'submission' | 'report' | 'post' | 'flower';
  /** 一句话标题，服务端拼好。文案归服务端管，前端不再二次解释。 */
  title: string;
  /** 补充说明：驳回理由、举报处置备注、下架原因。没有就是 null。 */
  detail: string | null;
  /** 点进去看哪儿。没有可跳转的目标时是 null。 */
  href: string | null;
  at: ISODateTime;
}
export type GetMyNotificationsRequest = PaginationQuery;
export type GetMyNotificationsResponse = PaginatedResponse<NotificationItem>;
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
  /** 只看某个人写的。作者主页用它，不另开一条「按作者取文章」的接口。 */
  author?: string;
}
export type GetPostsResponse = PaginatedResponse<PostSummary>;
export interface GetPostRequest { id: string }

/**
 * 站点页的一句话反馈。
 *
 * `verdict` 是用户的自述判断，不是平台实测：它和 `Station.uptime` 是两回事，
 * 展示时必须标明「用户自述，未经平台核实」。
 */
export type FeedbackVerdict = 'works' | 'slow' | 'broken';
export interface Feedback {
  id: string;
  stationSlug: string;
  author: Author;
  verdict: FeedbackVerdict;
  content: string;
  createdAt: ISODateTime;
  /** 本人发的才能删。 */
  mine: boolean;
  /**
   * 永远是 false：这是**用户自述**，不是平台实测。
   *
   * 字段本身冗余，但它让「未经核实」成为响应里可断言的事实，而不是只写在
   * 页面文案上——消费方（含 Agent、第三方）拿到数据就能看到它没被核实过。
   */
  verified: false;
}
export interface CreateFeedbackRequest {
  stationSlug: string;
  verdict: FeedbackVerdict;
  content: string;
}
export interface GetFeedbackRequest extends PaginationQuery {
  stationSlug: string;
}
export interface DeleteFeedbackRequest { id: string }

/** 公开作者主页。只有本来就公开的信息，不含邮箱之类。 */
export interface PublicProfile {
  handle: string;
  nickname: string;
  avatar: string;
  bio: string;
  shareCount: number;
  /** 这些文章收到的赞数合计，用来给主页一个「被多少人认可」的量。 */
  upCount: number;
  joinedAt: ISODate | null;
}
export interface GetUserRequest { handle: string }
export type GetUserResponse = PublicProfile;
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
  | (PaginatedResponse<ExpertRanking> & { tab: 'expert' })
  | (PaginatedResponse<StationRanking> & { tab: 'station' });
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

// POST /api/admin/import 的通用全量导入内容。
// 这是受保护的运维接口，不属于公开 API，所以不进 ApiContracts 和 API_ROUTES。
export interface CatalogImportStation {
  slug: string;
  name: string;
  description: string;
  url: string;
  rechargeThreshold: number | null;
  paymentMethods: string[];
  offers: { modelSlug: string; rate: number; basis?: RateBasis; quotedAt?: ISODateTime | null }[];
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
  createAgentToken: { request: CreateAgentTokenRequest; response: ApiResponse<CreateAgentTokenResponse> };
  getAgentTokens: { request: GetAgentTokensRequest; response: ApiResponse<GetAgentTokensResponse> };
  deleteComment: { request: DeleteCommentRequest; response: ApiResponse<DeleteCommentResponse> };
  deletePost: { request: DeletePostRequest; response: ApiResponse<DeletePostResponse> };
  createReport: { request: CreateReportRequest; response: ApiResponse<CreateReportResponse> };
  revokeAgentToken: { request: RevokeAgentTokenRequest; response: ApiResponse<RevokeAgentTokenResponse> };
  createAgentStation: { request: CreateAgentStationRequest; response: ApiResponse<CreateAgentStationResponse> };
  createAgentPost: { request: CreateAgentPostRequest; response: ApiResponse<CreateAgentPostResponse> };
  createAgentModel: { request: CreateAgentModelRequest; response: ApiResponse<CreateAgentModelResponse> };
  suggestModel: { request: SuggestModelRequest; response: ApiResponse<SuggestModelResponse> };
  suggestStation: { request: SuggestStationRequest; response: ApiResponse<SuggestStationResponse> };
  getAgentStatus: { request: GetAgentStatusRequest; response: ApiResponse<GetAgentStatusResponse> };
  getMe: { request: GetMeRequest; response: ApiResponse<GetMeResponse> };
  updateMe: { request: UpdateMeRequest; response: ApiResponse<UpdateMeResponse> };
  checkIn: { request: CheckInRequest; response: ApiResponse<CheckInResponse> };
  getMyFavorites: { request: GetMyFavoritesRequest; response: ApiResponse<GetMyFavoritesResponse> };
  getMyPosts: { request: GetMyPostsRequest; response: ApiResponse<GetMyPostsResponse> };
  getMySubmissions: { request: PaginationQuery; response: ApiResponse<GetMySubmissionsResponse> };
  getMyNotifications: { request: GetMyNotificationsRequest; response: ApiResponse<GetMyNotificationsResponse> };
  getVendors: { request: GetVendorsRequest; response: ApiResponse<GetVendorsResponse> };
  getModels: { request: GetModelsRequest; response: ApiResponse<GetModelsResponse> };
  getModel: { request: GetModelRequest; response: ApiResponse<GetModelResponse> };
  getStations: { request: GetStationsRequest; response: ApiResponse<GetStationsResponse> };
  getStation: { request: GetStationRequest; response: ApiResponse<GetStationResponse> };
  getPosts: { request: GetPostsRequest; response: ApiResponse<GetPostsResponse> };
  getUser: { request: GetUserRequest; response: ApiResponse<GetUserResponse> };
  createFeedback: { request: CreateFeedbackRequest; response: ApiResponse<Feedback> };
  getFeedback: { request: GetFeedbackRequest; response: ApiResponse<PaginatedResponse<Feedback>> };
  deleteFeedback: { request: DeleteFeedbackRequest; response: ApiResponse<{ id: string; deleted: true }> };
  getPost: { request: GetPostRequest; response: ApiResponse<GetPostResponse> };
  createPost: { request: CreatePostRequest; response: ApiResponse<CreatePostResponse> };
  deleteAccount: { request: DeleteAccountRequest; response: ApiResponse<DeleteAccountResponse> };
  getMyTokens: { request: GetMyTokensRequest; response: ApiResponse<GetMyTokensResponse> };
  getTokenLedger: { request: GetTokenLedgerRequest; response: ApiResponse<GetTokenLedgerResponse> };
  redeemTokens: { request: RedeemTokensRequest; response: ApiResponse<RedeemTokensResponse> };
  submitRevision: { request: SubmitRevisionRequest; response: ApiResponse<SubmitRevisionResponse> };
  getRevision: { request: GetRevisionRequest; response: ApiResponse<GetRevisionResponse> };
  withdrawRevision: { request: WithdrawRevisionRequest; response: ApiResponse<WithdrawRevisionResponse> };
  putVote: { request: PutVoteRequest; response: ApiResponse<PutVoteResponse> };
  putFavorite: { request: PutFavoriteRequest; response: ApiResponse<PutFavoriteResponse> };
  getComments: { request: GetCommentsRequest; response: ApiResponse<GetCommentsResponse> };
  createComment: { request: CreateCommentRequest; response: ApiResponse<CreateCommentResponse> };
  getRankings: { request: GetRankingsRequest; response: ApiResponse<GetRankingsResponse> };
  getBanners: { request: GetBannersRequest; response: ApiResponse<GetBannersResponse> };
  search: { request: SearchRequest; response: ApiResponse<SearchResponse> };
  getHotSearches: { request: GetHotSearchesRequest; response: ApiResponse<GetHotSearchesResponse> };
  createInviteCode: { request: CreateInviteCodeRequest; response: ApiResponse<CreateInviteCodeResponse> };
  getInviteCodes: { request: GetInviteCodesRequest; response: ApiResponse<GetInviteCodesResponse> };
  revokeInviteCode: { request: RevokeInviteCodeRequest; response: ApiResponse<RevokeInviteCodeResponse> };
}
