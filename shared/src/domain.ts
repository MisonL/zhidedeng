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
// demo：虚构演示数据；submission：群友提交；agent：AI 采集。后两者未经平台核实。
export type ContentSource = 'demo' | 'submission' | 'agent';
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

// 凭证管理列表的元数据，不含明文和哈希。
export interface AgentToken {
  id: Id;
  label: string;
  tokenPrefix: string;
  createdAt: ISODateTime;
  lastUsedAt: ISODateTime | null;
  revokedAt: ISODateTime | null;
  useCount: number;
  status: 'active' | 'revoked';
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
  /**
   * 社区最后一次在这站下面发言的时间（只算可见评论）。
   *
   * 「最后确认」是个保守说法：有人在下面说话，说明他至少最近还关注着这个站。
   * 没有评论就是 null，显示成「还没有人聊过」，不要拿建站时间冒充活跃度。
   */
  lastConfirmedAt: ISODate | null;
  source: ContentSource | 'user';
}

/**
 * 倍率的计价口径。
 *
 * `rate` 本身只说「相对官方价多少」，不说这个数字是怎么算出来的。中转站至少
 * 有四种常见口径，同一个数字在不同口径下差得很远：输入按量、输出按量、
 * 打包价、以及把输入输出混在一起的整站倍率。它们放在同一张榜上排序是错的，
 * 但 schema 里原先没有字段能表达差异，只能靠审核时人判断——榜上却写着
 * 「数字越小越便宜」。
 */
export type RateBasis = 'blended' | 'input' | 'output' | 'package';

export interface StationOffer {
  stationSlug: string;
  modelSlug: string;
  // 仅表示相对官方价格的倍率。
  rate: number;
  /** 这个倍率对应的口径。历史数据没有该字段时按 blended 读。 */
  basis: RateBasis;
  /** 报价来源时间（提交/同步时给出）。null 表示来源没说，不代表「刚刚」。 */
  quotedAt: ISODateTime | null;
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
  /**
   * 内容版本号：每次「编辑并通过审核」+1。缺省按 1 读（老文章没有这个字段）。
   *
   * 用途是判断「举报被判不成立之后，内容有没有变过」——用时间戳比会有同毫秒
   * 漏判，而且「改回原文」在语义上也不该算改动，版本号能表达得更准。
   */
  contentVersion?: number;
  /** 最后一次编辑通过审核的时间；从未编辑过为 null。 */
  revisedAt?: ISODateTime | null;
  /**
   * 作者有一版修改正在排队（只有作者本人读得到）。
   * 线上内容此刻仍是旧版——读者无感，作者需要看到「我的修改在审核」。
   */
  pendingRevision?: { id: string; submittedAt: string } | null;
  /**
   * 审核理由（驳回原因），仅对作者本人可见。
   *
   * 之前这个字段不存在：作者在「我的分享」里看得到 status=rejected，
   * 却完全不知道哪里不合格——服务端明明把理由写进了 submissions.reason，
   * 却没有任何接口把它送出来。只有作者自己能看到，别人读到的仍是 undefined。
   */
  reviewReason?: string | null;
}

/**
 * 列表里的文章：不带正文。
 *
 * 正文上限 10 万字，而列表每页 20 条——带上它最坏是一次 2MB 的响应，
 * 而卡片只需要标题和摘要。详情页有独立接口 `GET /api/posts/:id`。
 */
export type PostSummary = Omit<Post, 'body'>;

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
  /** 作者已删除。回复本身没有子行，删除时会物理删掉，所以这个标记实际只会出现在顶层评论上。 */
  deleted?: boolean;
}

export interface Comment extends Target {
  id: Id;
  author: Author;
  /** 已删除时为空串；正文在删除时就被清掉，不留在库里。 */
  content: string;
  parentId: null;
  createdAt: ISODateTime;
  replies: CommentReply[];
  /**
   * 作者已删除。这条评论**还有别人回复**，物理删会连带删掉别人的内容或撞外键，
   * 所以保留一行墓碑：正文清空、作者仍是本人（他删的是自己的话，不是注销账号）。
   */
  deleted?: boolean;
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

export type RankingTab = 'model' | 'community' | 'expert' | 'station';
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

/**
 * 站点榜。
 *
 * 刻意只复用 `getStations({ sort: 'score' })` 的排序，不在这里另算一套分数：
 * 榜单和 /stations 给出不同顺序时，读者会认为其中一个是错的。
 */
export interface StationRanking {
  rank: number;
  station: Station;
}

/**
 * 前后端共用的展示类字段长度上限。
 * 分开写死会让前端放行、后端 400——用户只看到「请求参数无效」，不知道是长度问题。
 * 放在这里而不是 submission.ts：后者依赖 zod，前端只引常量时不该把 zod 带进产物。
 */
export const PROFILE_LIMITS = { nickname: 20, bio: 500 } as const;

/**
 * 预设头像集合。
 *
 * 头像刻意**不提供上传/外链**：外链让运营彻底失控（隐私追踪、钓 鱼图、
 * 整站变慢都来自第三方图片），上传要存文件、要管 Content-Type 与尺寸，
 * 两个都远超「让个人主页不那么空」这个需求的成本。预设是表情符号，
 * 由前端用昵称底色画出来，语义仍然是「换一个代表自己的图案」。
 */
export const AVATAR_PRESETS = ['🦊', '🐼', '🐯', '🦁', '🐸', '🐙', '🦄', '🐳', '🦉', '🐧'] as const;
export type AvatarPreset = (typeof AVATAR_PRESETS)[number];

/**
 * 每个预设的中文名。
 *
 * 选择器里原来把 emoji 显示两遍（图案一次、文字一次），读屏念出来是「🦊 🦊」；
 * 而单独一个 emoji 也说不出是什么动物。给它一个名字，可见文字和读屏都清楚了。
 */
export const AVATAR_PRESET_NAMES: Record<AvatarPreset, string> = {
  '🦊': '狐狸', '🐼': '熊猫', '🐯': '老虎', '🦁': '狮子', '🐸': '青蛙',
  '🐙': '章鱼', '🦄': '独角兽', '🐳': '鲸鱼', '🦉': '猫头鹰', '🐧': '企鹅',
};
