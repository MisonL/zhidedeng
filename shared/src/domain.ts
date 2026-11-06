export type Id = string;
export type ISODateTime = string;
export type ISODate = string;
export type VendorSlug = string;
export const MIN_RATE = 0.05;
export const MAX_RATE = 20;
export type PostKind = 'deal' | 'review' | 'community' | 'guide';
export type StationStatus = 'running' | 'unstable';
export type TargetType = 'post' | 'station';
export type VoteValue = 'up' | 'down' | null;
// demo：虚构演示数据；submission：群友经飞书表单提交，未经平台核实。
export type ContentSource = 'demo' | 'submission';
export type PostStatus = 'pending' | 'approved' | 'rejected';

export interface Vendor {
  slug: VendorSlug;
  name: string;
  iconKey: string;
}

export interface Model {
  slug: string;
  vendor: VendorSlug;
  name: string;
  description: string;
  tags: string[];
}

export type ModelSummary = Pick<Model, 'slug' | 'vendor' | 'name' | 'description' | 'tags'>;
export interface VendorWithModels extends Vendor {
  models: ModelSummary[];
}

export interface User {
  handle: string;
  nickname: string;
  avatar: string;
  bio: string;
  tokens: number;
}

export type Author = Pick<User, 'handle' | 'nickname' | 'avatar'>;
export interface CurrentUser extends User {
  checkedInToday: boolean;
  streak: number;
  favoriteCount: number;
  shareCount: number;
}

export interface Target {
  targetType: TargetType;
  // 文章使用 id，中转站使用 slug。
  targetId: Id;
}

export interface Vote extends Target {
  userHandle: string;
  value: Exclude<VoteValue, null>;
}

export interface VoteSummary {
  up: number;
  down: number;
  total: number;
  // 比例采用 0~1，无投票时为 0。
  upRatio: number;
}

export interface InteractionState {
  votes: VoteSummary;
  currentUserVote: VoteValue;
  favorited: boolean;
  favoriteCount: number;
  commentCount: number;
}

export interface Station extends InteractionState {
  slug: string;
  name: string;
  description: string;
  rechargeThreshold: number | null;
  paymentMethods: string[];
  // 可用率采用百分数 0~100；延迟单位为毫秒。下列指标没有实测数据时为 null，绝不填默认值。
  uptime: number | null;
  firstTokenLatencyMs: number | null;
  foundedAt: ISODate | null;
  status: StationStatus | null;
  lowestRate: number | null;
  // 依赖可用率，可用率为 null 时同为 null，排序时排在有分数的站点之后。
  score: number | null;
  // 只含协议、主机和路径，不带 query 与 fragment。
  url: string | null;
  source: ContentSource;
}

export interface StationOffer {
  stationSlug: string;
  modelSlug: string;
  // 仅表示相对官方价格的倍率。
  rate: number;
}

export interface ModelOffer extends StationOffer {
  station: Station;
}

export interface StationModelOffer extends StationOffer {
  model: Model;
}

export interface ModelDetail extends Model {
  // 服务端按 rate 升序返回。
  offers: ModelOffer[];
}

export interface StationDetail extends Station {
  offers: StationModelOffer[];
}

export interface Post extends InteractionState {
  id: Id;
  kind: PostKind;
  title: string;
  summary: string;
  body: string;
  author: Author;
  stationSlug: string | null;
  modelSlug: string | null;
  cover: string | null;
  publishedAt: ISODateTime;
  // user：登录用户的投稿。
  source: ContentSource | 'user';
  // pending/rejected 只有作者本人读得到。
  status: PostStatus;
}

export interface Favorite extends Target {
  userHandle: string;
  createdAt: ISODateTime;
}

export type FavoriteItem = Favorite & (
  | { targetType: 'post'; post: Post }
  | { targetType: 'station'; station: Station }
);

export interface CommentReply extends Target {
  id: Id;
  author: Author;
  content: string;
  parentId: Id;
  createdAt: ISODateTime;
}

export interface Comment extends Target {
  id: Id;
  author: Author;
  content: string;
  parentId: null;
  createdAt: ISODateTime;
  replies: CommentReply[];
}

export interface CheckIn {
  userHandle: string;
  date: ISODate;
  tokensAwarded: number;
  streak: number;
}

export interface Banner {
  id: Id;
  title: string;
  description: string;
  image: string;
  href: string;
}

export type RankingTab = 'model' | 'community' | 'expert';
export interface ModelRanking {
  rank: number;
  model: Model;
  lowestRate: number | null;
  stationCount: number;
}

export interface CommunityRanking {
  rank: number;
  post: Post;
}

export interface ExpertRanking {
  rank: number;
  user: User;
  shareCount: number;
  upCount: number;
}
