import { AVATAR_PRESETS } from '@zhidedeng/shared';
import type {
  Author, CheckInResponse, Comment, CommentReply, CreateCommentRequest,
  CreateFeedbackRequest, CreateReportRequest, CurrentUser, Favorite, FavoriteItem, GetCommentsRequest, GetModelsRequest, GetPostsRequest,
  GetRankingsRequest, GetRankingsResponse, GetStationsRequest, InteractionState, ModelDetail,
  Feedback, FeedbackVerdict, GetFeedbackRequest, PaginationQuery, Post, PublicProfile, PutFavoriteRequest, PutFavoriteResponse, PutVoteRequest, PutVoteResponse,
  SearchResponse, Station, StationDetail, StationOffer, SubmissionStatus, Target, UpdateMeRequest,
  User, VendorWithModels, Vote,
} from '@zhidedeng/shared';
import { ApiError, isDatabaseBusyError, isUniqueConstraintError } from './errors.ts';
import { INITIAL_TOKENS } from './auth.ts';
import { Store } from './database.ts';
import type { PostRecord, StationRecord } from './database.ts';
// 只借一个纯函数算 hostname，避免和 submissions.ts 之间形成运行时循环依赖：
// submissions.ts 不 import service.ts，这个方向是单向的。
import { hostnameOf } from './submissions.ts';

const dayMs = 86400000;
const shanghaiDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

export function paginate<T>(items: T[], query: PaginationQuery) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
}

/**
 * 分页后再逐条组装。
 *
 * `paginate(records.map(toDto), query)` 会把**全库**记录都转成 DTO 再丢掉
 * 除本页之外的全部——每条 DTO 都要查票数、收藏、评论数、作者，一次请求的
 * 数据库工作量因此随全库增长，而不是随页大小。排序仍需要全量记录，所以这里
 * 只把「组装」推迟到切片之后：排序用记录本身的字段，组装只做本页。
 */
export function paginateThen<T, D>(items: T[], query: PaginationQuery, project: (item: T) => D) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  return { items: items.slice((page - 1) * pageSize, page * pageSize).map(project), total: items.length, page, pageSize };
}

function emptyInteraction(): InteractionState {
  return { votes: { up: 0, down: 0, total: 0, upRatio: 0 }, currentUserVote: null, favorited: false, favoriteCount: 0, commentCount: 0 };
}

function matches(query: string | undefined, ...texts: string[]) {
  return !query || texts.join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

// 被隐藏的评论和挂在它下面的回复都不算数。
//
// 子查询必须带 targetType/targetId 限定：不带的话每次求值都要扫整张 comments
// 表（EXPLAIN 是 SCAN comments），而这条条件在列表页每条记录上都要用一次。
// 隐藏判定本来就只在「同一个目标」内部有意义，加限定不改变语义。
/**
 * 预取互动数据的取舍阈值。
 *
 * 全量聚合的固定成本（扫该类型的票/收藏/评论）要摊到本页条数上。实测交叉点
 * 在百条量级：低于它，按 id 点查更快；高于它，全量聚合明显更快。
 */
const PREFETCH_MIN_ROWS = 100;

// hidden = 管理隐藏（含连带隐藏其回复）；deletedAt = 作者自删的墓碑。
// 计数只算真正有内容的评论：墓碑是空壳，算进「N 条评论」会让数字虚高。
// 列表查询另走一套（hidden = 0），因为别人回复还挂在墓碑下面，得把它取出来才能渲染。
const COMMENT_VISIBLE = 'hidden = 0 AND deletedAt IS NULL AND (parentId IS NULL OR parentId NOT IN (SELECT id FROM comments WHERE hidden = 1 AND targetType = comments.targetType AND targetId = comments.targetId))';
const COMMENTS_PER_MINUTE = 5;
// 一句话反馈：每小时 5 条挡瞬间刷屏，每天 20 条挡「一小时 5 条慢慢刷」。
const FEEDBACK_PER_HOUR = 5;
const FEEDBACK_PER_DAY = 20;
const FEEDBACK_MAX_LENGTH = 140;
// 举报是零成本动作：没有配额时一个人可以连发几百条，把审核台淹掉。
// 一小时 20 条足够正常用户表达不满，又不足以刷屏。
const REPORTS_PER_HOUR = 20;
const POSTS_PER_HOUR = 10;
const MAX_PENDING_POSTS = 20;
const MIN_OFFERS_FOR_RATE = 3;
/**
 * 按发布时间比较，**按真实时刻**而不是字符串。
 *
 * publishedAt 允许带时区偏移（`z.iso.datetime({ offset: true })`，因为 Agent 从中文
 * 站点抓到的多是 `+08:00`），所以字符串比较会跟时间比较给出相反结论：
 *   A = 2026-11-17T09:00:00+08:00（UTC 01:00）
 *   B = 2026-11-17T02:00:00Z     （UTC 02:00）
 * 字符串比 `'17T09' > '17T02'` 认为 A 更晚，实际 A 更早一小时。
 * 结果是「最新」列表顺序错乱——实测 A 排在了 B 前面。
 *
 * 解析失败时退回字符串比较，保证顺序至少稳定（不会变成随机）。
 */
export function comparePublishedAt(a: string, b: string): number {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return a.localeCompare(b);
  return left - right;
}

const POST_AUTHOR = "kind = 'post' AND json_extract(data,'$.authorHandle') = ?";

const descendingNullsLast = (a: number | null, b: number | null) => (b ?? -Infinity) - (a ?? -Infinity) || 0;

/** 每个请求构造一个；handle 是当前登录账号，未登录时为 null。 */
/**
 * 展示名里的保留词。界面只显示 nickname 不显示 handle，
 * 昵称叫「什么值得蹬官方」就能冒充平台身份。
 */
/**
 * 展示名里的保留身份。
 *
 * 只在**整段归一后完全相等**时拒绝，不做「包含」判断：
 * 「官方粉丝」「系统工程师」「中国女排官方」都是正常昵称，
 * 按包含判定会把它们一起挡掉。
 * 代价是「什么值得蹬官方」这类带前后缀的写法拦不住——那由审核界面
 * 的高亮与重名判定兜底，比误伤一大片正常用户划算。
 */
/**
 * 昵称的可比形式：去掉不可见字符 + NFKC 归一 + 转小写。
 *
 * 只做 trim 不够。实测「管理员」被保留名单拒绝，但「管理员\u200B」
 * （尾部零宽空格）、「管理员\u200D」、「管\u200B理员」都能注册成功——
 * 视觉上完全一样，等于绕过了保留身份，也给重名判定开了口子。
 * NFKC 顺带把全角、兼容字符折成标准形态（「ＡＤＭＩＮ」→「admin」）。
 */
export function normalizeNickname(nickname: string): string {
  return nickname
    // 零宽、方向控制符、BOM 等：肉眼不可见，但参与字符串比较
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
}

/** 昵称是否用了保留身份。注册与改资料走同一套判定。 */
export function isReservedNickname(nickname: string): boolean {
  const normalized = normalizeNickname(nickname);
  // 降级占位带 handle 后缀（`已注销用户·xxx`）以便区分不同的人，
  // 所以这里对这一个前缀额外做「开头匹配」。其余保留词仍只做整段相等：
  // 按包含判定会把「官方粉丝」「系统工程师」这类正常昵称一起挡掉。
  if (normalized.startsWith('已注销用户')) return true;
  return RESERVED_NICKNAMES.has(normalized);
}

const RESERVED_NICKNAMES = new Set([
  '官方', '管理员', 'admin', 'administrator', '客服', '版主', '小编', '系统',
  // 作者实体缺失时的降级占位。不挡住的话，任何人都能把昵称改成这个字符串，
  // 冒充「已注销」身份；而真正的降级占位反而失去区分力。
  '已注销用户',
]);

/** 报价表的展示顺序：综合在前，其余按「谁更常被拿来比」排。 */
const BASIS_ORDER = ['blended', 'input', 'output', 'package'];
/**
 * 口径的排序位次。认不出的口径排**最后**，不能靠 `indexOf` 返回的 -1 排到最前：
 * 老库的 ALTER 补不上 CHECK，历史脏值确实可能存在；一旦它排到第一行，
 * 前端会把第一行标成「最便宜」，等于拿一个没人认识的字符串给站点背书。
 */
const basisRank = (basis: string | undefined) => {
  if (basis === undefined) return 0;
  const index = BASIS_ORDER.indexOf(basis);
  return index === -1 ? BASIS_ORDER.length : index;
};

/**
 * 报价表的展示顺序：先按口径分组、组内按倍率升序。
 *
 * 只按 rate 排会把「按输入 0.3」排在「综合 0.5」前面，而这两个数字不可比——
 * 第一行会被读者当成「最便宜」。综合口径排最前（它代表整站常态），
 * 认不出的口径排最后（见 basisRank）。
 */
export const sortOffersForDisplay = <T extends { rate: number; basis?: string }>(offers: readonly T[]): T[] =>
  [...offers].sort((a, b) => basisRank(a.basis) - basisRank(b.basis) || a.rate - b.rate);

export class Service {
  readonly store: Store;
  readonly now: () => Date;
  readonly handle: string | null;

  constructor(store: Store, now: () => Date, handle: string | null) {
    this.store = store;
    this.now = now;
    this.handle = handle;
  }

  private get user() {
    if (!this.handle) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
    return this.handle;
  }

  /**
   * 作者信息。**用户实体缺失时不能崩**。
   *
   * 原来这里是 `store.get('user', handle)!`：只要有一条文章或评论的作者
   * 在 users 里找不到，解构就会抛 TypeError，而被它打挂的不是那一条，
   * 是**所有包含它的列表**——首页、社区、评测、搜索、榜单、收藏、我的分享。
   * 触发条件不止「账号注销」：手工删库、迁移出错、早期演示数据残留都会。
   *
   * 现在降级成「已注销用户」，handle 保留原值（前端用它做 key 与链接）。
   */
  /**
   * 当前登录用户对应的实体，缺失时**自动重建**。
   *
   * 会话校验（`sessionHandle`）只确认 `accounts` 里有这一行，不保证 `entities`
   * 里也有同名 user 记录——两者由不同代码路径写入，手工删库、迁移出错、
   * 早期演示数据都可能只留下其中一边。以前这里用 `!` 假装一定存在，
   * 缺失时 `{...undefined}` 不报错，而是静默返回缺字段的对象，
   * 下游（改昵称、签到）再整体展开覆写，等于用半个对象覆盖完整记录。
   *
   * 为什么不用 401 让用户「重新登录」：会话是有效的，账号也在，缺的只是一条
   * 派生资料。发 401 会让「重新登录」这条路永远失败（登录接口本身也要读这条
   * 记录），而重新注册会撞 409 —— 把一个能自动修好的状态变成必须人工改库。
   * 重建是幂等的：昵称取 handle（用户自己的标识，不伪造身份），其余取默认。
   */
  private requireUser(): User {
    const existing = this.store.get('user', this.user);
    if (existing) return existing;
    const rebuilt: User = { handle: this.user, nickname: this.user, avatar: '', bio: '', tokens: INITIAL_TOKENS };
    this.store.put('user', this.user, rebuilt);
    return rebuilt;
  }

  private author(handle: string): Author {
    const user = this.store.get('user', handle);
    if (user) return { handle, nickname: user.nickname, avatar: user.avatar };
    // 昵称带上 handle，否则不同缺失用户的评论会显示成同一个名字、同一个头像
    // （Avatar 用昵称算字形与底色），读者分不清是一条历史评论还是好几个人。
    return { handle, nickname: `已注销用户·${handle}`, avatar: '' };
  }

  /**
   * 一次性取回某类目标的全部互动数据，按 targetId 建索引。
   *
   * 列表页原先对每条记录调用 interaction()，各查票数、收藏、评论数三张表；
   * 站点有几百个时，取 20 条的一页要发近千条 SQL。三条聚合查询换成三次
   * 全表分组，工作量与页大小无关。
   */
  private interactionMap(targetType: Target['targetType']): Map<string, InteractionState> {
    const votes = this.store.db.prepare(
      `SELECT targetId, userHandle, value FROM votes WHERE targetType = ?`,
    ).all(targetType) as unknown as (Pick<Vote, 'userHandle' | 'value'> & { targetId: string })[];
    const favorites = this.store.db.prepare(
      'SELECT targetId, userHandle FROM favorites WHERE targetType = ?',
    ).all(targetType) as { targetId: string; userHandle: string }[];
    const comments = this.store.db.prepare(
      `SELECT targetId, count(*) AS count FROM comments WHERE targetType = ? AND ${COMMENT_VISIBLE} GROUP BY targetId`,
    ).all(targetType) as { targetId: string; count: number }[];

    const map = new Map<string, InteractionState>();
    const state = (id: string) => {
      let entry = map.get(id);
      if (!entry) {
        // 与 emptyInteraction() 共用一个工厂：两处字面量各写一份，改一处漏一处。
        entry = emptyInteraction();
        map.set(id, entry);
      }
      return entry;
    };
    for (const vote of votes) {
      const entry = state(vote.targetId);
      if (vote.value === 'up') entry.votes.up += 1; else entry.votes.down += 1;
      entry.votes.total = entry.votes.up + entry.votes.down;
      entry.votes.upRatio = entry.votes.total ? entry.votes.up / entry.votes.total : 0;
      if (vote.userHandle === this.handle) entry.currentUserVote = vote.value;
    }
    for (const favorite of favorites) {
      const entry = state(favorite.targetId);
      entry.favoriteCount += 1;
      if (favorite.userHandle === this.handle) entry.favorited = true;
    }
    for (const comment of comments) state(comment.targetId).commentCount = Number(comment.count);
    return map;
  }

  private interaction(target: Target): InteractionState {
    const { targetType, targetId } = target;
    const votes = this.store.db.prepare('SELECT userHandle,value FROM votes WHERE targetType=? AND targetId=?').all(targetType, targetId) as unknown as Pick<Vote, 'userHandle' | 'value'>[];
    const up = votes.filter(v => v.value === 'up').length;
    const down = votes.length - up;
    const favorites = this.store.db.prepare('SELECT userHandle FROM favorites WHERE targetType=? AND targetId=?').all(targetType, targetId);
    const count = this.store.db.prepare('SELECT count(*) AS count FROM comments WHERE targetType=? AND targetId=? AND ' + COMMENT_VISIBLE).get(targetType, targetId)!;
    return {
      votes: { up, down, total: up + down, upRatio: up + down ? up / (up + down) : 0 },
      currentUserVote: votes.find(v => v.userHandle === this.handle)?.value ?? null,
      favorited: favorites.some(f => f.userHandle === this.handle), favoriteCount: favorites.length, commentCount: Number(count.count),
    };
  }

  /**
   * 每个站点的「社区最后确认时间」：可见评论里最新的一条。
   *
   * 一条 GROUP BY 查完。站点只有几十个，逐站查代价相同但次数翻几十倍；
   * 也不做成 schema 字段——那需要每次发评论时回写站点，反而多一处可能不一致的
   * 冗余（删评论、隐藏评论都要跟着改）。
   */
  private lastConfirmedMap(): Map<string, string> {
    const rows = this.store.db.prepare(
      `SELECT targetId, max(createdAt) AS last FROM comments WHERE targetType = 'station' AND ${COMMENT_VISIBLE} GROUP BY targetId`,
    ).all() as Array<{ targetId: string; last: string }>;
    return new Map(rows.map(row => [row.targetId, row.last]));
  }

  private station(record: StationRecord, prefetched?: Map<string, InteractionState>, lastConfirmed?: Map<string, string>): Station {
    // 传了预取表就一律走表：没有互动的站点不在表里，此时要用「全零」而不是
    // 回退到单条查询——否则「零互动的站点」恰好是最多的那一类，等于没优化。
    const interaction = prefetched
      ? (prefetched.get(record.slug) ?? emptyInteraction())
      : this.interaction({ targetType: 'station', targetId: record.slug });
    const offers = this.offersByStation().get(record.slug) ?? [];
    // 最低倍率只算综合口径。按输入 0.3 和打包价 0.5 取 min 得到 0.3，
    // 卡片上就成了「低至 0.3x」——那是个只对输入 token 成立的数字，
    // 和「整站最低价」不是一回事。榜单的 1/lowestRate 加分同理。
    // 没有任何综合口径报价时返回 null（显示「暂无报价」），而不是拿别的口径冒充。
    const blended = offers.filter(offer => (offer.basis ?? 'blended') === 'blended');
    const lowestRate = blended.length ? Math.min(...blended.map(offer => offer.rate)) : null;
    const score = record.uptime === null ? null : Number((record.uptime * 0.6 + (interaction.votes.total ? interaction.votes.upRatio : 0.5) * 30 + (1 / (lowestRate ?? 1)) * 3).toFixed(2));
    return { ...record, ...interaction, lowestRate, score, lastConfirmedAt: lastConfirmed?.get(record.slug) ?? null };
  }

  /** 刚入队的站内投稿：先拼出与 Post 一致的结构，审核通过后才从 entities 读。 */
  /** 刚入队的站内投稿，返回与 Post 一致的结构；自动通过时状态就是 approved。 */
  pendingPost(submission: { id: string; payload: unknown; actorHandle: string | null; createdAt: string; status?: string }): Post {
    // 这是「刚提交完，回显给你看的那一条」，要带正文；列表接口才不带。
    return this.post(this.queuedPost({
      id: submission.id, payload: submission.payload, status: submission.status ?? 'pending',
      actorHandle: submission.actorHandle ?? this.user, createdAt: submission.createdAt,
    }), undefined, true);
  }

  /**
   * 组装文章 DTO。`withBody` 只有详情页需要。
   *
   * 正文上限 10 万字，列表每页 20 条——带上它最坏是一次 2MB 的响应，而卡片
   * 只需要标题和摘要。列表一律不带 body，省的是传输量和 JSON.parse。
   */
  private post(record: PostRecord, prefetched?: Map<string, InteractionState>, withBody = false): Post {
    const { authorHandle, authorNickname, source, ...all } = record;
    const fields = withBody ? all : (({ body: _body, ...rest }) => rest)(all);
    const author = authorNickname ? { handle: authorHandle, nickname: authorNickname, avatar: '' } : this.author(authorHandle);
    const interaction = prefetched
      ? (prefetched.get(record.id) ?? emptyInteraction())
      : this.interaction({ targetType: 'post', targetId: record.id });
    // 列表调用返回的是 PostSummary（无 body），与 shared 的类型声明一致。
    return { ...fields, author, source: source ?? 'user', ...interaction } as Post;
  }

  // 每个站都要用，同一请求内只读一次。
  private cachedOffers?: StationOffer[];
  private cachedOffersByStation?: Map<string, StationOffer[]>;
  private offers(): StationOffer[] {
    // 只算在线站点的报价。下架是软删除，报价行仍在库里（恢复时要原样拿回来），
    // 但不能让它们继续参与最低倍率、榜单和模型页的统计。
    return this.cachedOffers ??= this.store.db.prepare(
      `SELECT offer.stationSlug, offer.modelSlug, offer.rate, offer.basis, offer.quotedAt
       FROM offers AS offer JOIN entities AS station ON station.kind = 'station' AND station.id = offer.stationSlug
       WHERE station.removedAt IS NULL`,
    ).all() as unknown as StationOffer[];
  }

  /**
   * 按站点分组的报价。station() 每个站点都要用它算最低倍率——
   * 直接在 offers() 数组上 filter 是 O(站点数 × 报价数)，900 站 7200 行时
   * 一个列表请求要 2.6 秒，而且和返回多少条无关。分组一次是 O(报价数)。
   */
  private offersByStation(): Map<string, StationOffer[]> {
    return this.cachedOffersByStation ??= (() => {
      const grouped = new Map<string, StationOffer[]>();
      for (const offer of this.offers()) {
        const bucket = grouped.get(offer.stationSlug);
        if (bucket) bucket.push(offer); else grouped.set(offer.stationSlug, [offer]);
      }
      return grouped;
    })();
  }

  /**
   * 有没有足够多的**可比**报价。
   *
   * 门槛原本只数条数。但「按输入 0.1」这类报价条数达标却算不出最低倍率
   * （`lowestRate` 只统计综合口径），于是这个站被分进「达标组」、倍率是 null，
   * 在 ?sort=rate 里排到真正有 0.5x 的站前面——一个没有可比价格的站排第一。
   * 所以门槛也按综合口径数。
   */
  private hasEnoughOffersForRate(offers: StationOffer[]): boolean {
    return offers.reduce((count, offer) => count + Number((offer.basis ?? 'blended') === 'blended'), 0) >= MIN_OFFERS_FOR_RATE;
  }

  /**
   * 公开内容；作者本人的待审和被拒投稿只出现在我的分享和详情页。
   *
   * 在 SQL 层就把非 approved 的行筛掉，而不是全量读出来再 filter：`load_all`
   * 的主要成本是逐行 JSON.parse，5000 篇文章时 187ms（其中解析 113ms），
   * 而 getPosts / 两个榜单 / search / getMyPosts 每个请求都要付一次。
   * 用表达式索引把「只看 approved」下推给 SQLite，解析量只跟真正要用的行成正比。
   */
  private approvedPosts() {
    const rows = this.store.db.prepare(
      "SELECT data FROM entities WHERE kind = 'post' AND removedAt IS NULL AND json_extract(data,'$.status') = 'approved' ORDER BY rowid",
    ).all();
    return rows.map(row => JSON.parse(row.data as string) as PostRecord);
  }

  private readablePost(id: string) {
    const post = this.store.get('post', id);
    if (post) return post.status === 'approved' || post.authorHandle === this.handle ? post : undefined;
    // 站内投稿现在先进队列，物化前只在 submissions 里。作者要能看到自己的待审稿。
    const row = this.store.db.prepare(
      "SELECT * FROM submissions WHERE id = ? AND kind = 'post' AND channel = 'web' AND status IN ('pending','rejected') AND actorHandle = ?",
    ).get(id, this.handle ?? '');
    return row ? this.queuedPost(row) : undefined;
  }

  requireTarget(target: Target) {
    const found = target.targetType === 'post' ? this.readablePost(target.targetId) : this.store.get('station', target.targetId);
    if (!found) throw new ApiError(404, 'NOT_FOUND', '目标不存在');
  }

  /** 站点被撤销或文章被下架后收藏行还在，只是不显示；对象恢复时收藏随之恢复。 */
  /**
   * 可读收藏的条数（隐藏/撤下的目标不算）。只查两张表的存在性，不组装 DTO。
   * 文章要 readble，站点要在线——与收藏列表里「看不到就不计数」保持一致。
   */
  private countVisibleFavorites(): number {
    // 一次 JOIN 数出来，而不是把每条收藏再单独查一遍（1000 条就是 1000 次点查，
    // 实测 279ms，而 /api/me 每次页面加载都会打）。
    // 条件是「目标仍然可见」：文章要 approved（或作者本人）+ 未下架，站点要在线。
    // 未物化的待审投稿只有作者本人看得到，所以按 actorHandle 匹配的那部分也算。
    const row = this.store.db.prepare(`
      SELECT count(*) AS count FROM favorites AS favorite
      LEFT JOIN entities AS target ON target.kind = favorite.targetType AND target.id = favorite.targetId
      WHERE favorite.userHandle = ?
        AND (
          -- 站内投稿物化前只在 submissions 里，readablePost 认这一类，这里也要认。
          -- 必须排在实体判定前面：它根本没有 entities 行，走不到下面的分支。
          EXISTS (
            SELECT 1 FROM submissions AS queued
            WHERE queued.id = favorite.targetId AND queued.kind = 'post' AND queued.channel = 'web'
              AND queued.status IN ('pending','rejected') AND queued.actorHandle = ?
          )
          OR (
            -- 实体要存在且未下架。LEFT JOIN 未命中时 removedAt 是 NULL，
            -- 光写 removedAt IS NULL 会把「目标已被删除」的收藏也算成可见。
            target.id IS NOT NULL AND target.removedAt IS NULL
            AND (
              favorite.targetType = 'station'
              OR json_extract(target.data,'$.status') = 'approved'
              OR json_extract(target.data,'$.authorHandle') = ?
            )
          )
        )
    `).get(this.user, this.handle ?? '', this.handle ?? '')!;
    return Number(row.count);
  }

  /**
   * 收藏列表。**先在下标层分页，再组装当前页**。
   *
   * 原来是先把全部收藏的目标都读出来、组装成 DTO 再 paginate：1000 收藏时
   * 要跑 6108 条 SQL、1565ms，而用户只看得到 20 条。现在只在 SQL 里取本页
   * 需要的那一段，组装也只做这 20 条。
   *
   * 「不可读的目标要跳过」这条老语义保留：一篇被隐藏的文章仍占它的收藏位，
   * 但不出现在结果里。为了在分页之后仍然正确，这里按页向后多取，直到凑够
   * page*pageSize 条可见项或耗尽——正常数据下第一轮就够了。
   */
  getMyFavorites(query: PaginationQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const total = Number(this.store.db.prepare('SELECT count(*) AS count FROM favorites WHERE userHandle=?').get(this.user)!.count);
    const visible: FavoriteItem[] = [];
    const needed = page * pageSize;
    const CHUNK = Math.max(needed, 50);
    let offset = 0;
    while (visible.length < needed && offset < total) {
      const chunk = this.store.db.prepare(
        'SELECT userHandle,targetType,targetId,createdAt FROM favorites WHERE userHandle=? ORDER BY createdAt DESC, rowid DESC LIMIT ? OFFSET ?',
      ).all(this.user, CHUNK, offset) as unknown as Favorite[];
      if (chunk.length === 0) break;
      offset += chunk.length;
      for (const favorite of chunk) {
        if (favorite.targetType === 'post') {
          const record = this.readablePost(favorite.targetId);
          if (!record) continue;
          visible.push({ ...favorite, targetType: 'post', post: this.getPost(favorite.targetId) });
        } else {
          const record = this.store.get('station', favorite.targetId);
          if (!record) continue;
          visible.push({ ...favorite, targetType: 'station', station: this.station(record) });
        }
      }
    }
    const start = (page - 1) * pageSize;
    // total 必须与「可见条数」严格一致，否则前端的 hasMore（data.length < total）
    // 永远不收敛，「加载更多」会一直可点。
    // 不能从本页的循环状态推：循环只扫到凑够 page*pageSize 就停，
    // 没扫到的部分会被当成可见（100 收藏里 50 条可见时，第 1 页报过 75）。
    // 所以单独数一次——它的口径与 items 的可见判定共用同一个谓词。
    return { items: visible.slice(start, start + pageSize), total: this.countVisibleFavorites(), page, pageSize };
  }

  /** 该账号一共投过多少篇（已物化 + 队列里待审的）。 */
  private countOwnPosts(): number {
    // 只算还在线的：撤下的文章在「我的分享」里已经看不到，把它算进 shareCount
    // 会出现「分享 3、列表 2 条」这种对不上的数字（专家榜同样只算在线的）。
    const materialized = Number(this.store.db.prepare(`SELECT count(*) AS count FROM entities WHERE ${POST_AUTHOR} AND removedAt IS NULL`).get(this.user)!.count);
    const queued = Number(this.store.db.prepare(
      "SELECT count(*) AS count FROM submissions WHERE kind = 'post' AND channel = 'web' AND actorHandle = ? AND status = 'pending'",
    ).get(this.user)!.count);
    return materialized + queued;
  }

  /** 该账号最近一小时提交的文章数（已物化 + 队列里的）。 */
  private postsInLastHour(): number {
    // 只数 submissions：站内投稿无论待审还是已物化都有一行，
    // 再把 entities 加进来会把同一篇算两次，10 篇/小时实际只剩 5 篇。
    const hourAgo = new Date(this.now().getTime() - 3_600_000).toISOString();
    return Number(this.store.db.prepare(
      // station 也要数：站内推荐新站走同一个队列，漏掉它等于给了一条
      // 不受限流和待审配额约束的通道（实测同一账号能连推 25 条，全部入队）。
      "SELECT count(*) AS count FROM submissions WHERE kind IN ('post','model','station') AND channel = 'web' AND actorHandle = ? AND createdAt > ?",
    ).get(this.user, hourAgo)!.count);
  }

  /**
   * 该账号当前待审的站内投稿数（已物化的 pending + 队列里的）。
   * 模型补录也算：它们同样占队列、同样要人审，不数进来就等于开了个无限入口。 */
  private pendingOwnPosts(): number {
    // 同上：pending 只可能出现在队列里，物化后的状态就是 approved。
    return Number(this.store.db.prepare(
      "SELECT count(*) AS count FROM submissions WHERE kind IN ('post','model','station') AND channel = 'web' AND actorHandle = ? AND status = 'pending'",
    ).get(this.user)!.count);
  }

  /** 投稿限流校验。站内投稿走队列后，路由层要先调这个再入队。 */
  assertCanSubmitPost(): void {
    if (this.postsInLastHour() >= POSTS_PER_HOUR) throw new ApiError(429, 'RATE_LIMITED', '投稿太频繁了，请稍后再试');
    if (this.pendingOwnPosts() >= MAX_PENDING_POSTS) throw new ApiError(429, 'PENDING_LIMIT', '待审核的投稿太多了，请等审核后再提交');
  }

  /** 队列里的站内投稿转成 PostRecord 形状，物化前也要能读。 */
  private queuedPost(row: Record<string, unknown>): PostRecord {
    // 从库读出来是 JSON 字符串，从 enqueueSubmission 返回时已经是对象。
    const raw = row.payload;
    const payload = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { kind: PostRecord['kind']; title: string; summary: string; body: string; stationSlug?: string | null; modelSlug?: string | null };
    return {
      ...payload, stationSlug: payload.stationSlug ?? null, modelSlug: payload.modelSlug ?? null,
      id: row.id as string, authorHandle: row.actorHandle as string, cover: null,
      // 状态要如实反映：自动通过时这条已经上站了，回 pending 会让前端显示「审核中」，
      // 用户刷新才发现早就发布了。
      publishedAt: row.createdAt as string,
      status: (row.status as string) === 'rejected' ? 'rejected' : (row.status as string) === 'approved' ? 'approved' : 'pending',
      // 驳回理由要跟着状态一起给作者：只显示「已拒绝」而不说哪里不合格，
      // 作者既改不了也不知道该不该重投。paylaod 里没有这个字段，只能从
      // submissions.reason 带出来；未驳回时给 null 而不是 undefined，
      // 前端可以直接判断「有没有理由」。
      reviewReason: (row.reason as string | null | undefined) ?? null,
    } as PostRecord;
  }

  getMe(): CurrentUser {
    const today = shanghaiDate.format(this.now());
    const yesterday = shanghaiDate.format(new Date(this.now().getTime() - dayMs));
    const last = this.store.db.prepare('SELECT date,streak FROM checkins WHERE userHandle=? ORDER BY date DESC LIMIT 1').get(this.user);
    return {
      ...this.requireUser(), checkedInToday: last?.date === today,
      streak: last && (last.date === today || last.date === yesterday) ? Number(last.streak) : 0,
      // 只要个数，不要内容：原来调 myFavorites() 会把每个收藏的目标都读出来并
      // 逐条组装详情（1000 收藏时 1023 条 SQL / 364ms），而 /api/me 每次页面
      // 加载都会打一次。但「不可读的目标不计入」这条语义必须保留——
      // 收藏了一篇后来被撤下的文章，收藏数不该还把那一条算进去。
      favoriteCount: this.countVisibleFavorites(),
      shareCount: this.countOwnPosts(),
    };
  }

  updateMe(input: UpdateMeRequest): CurrentUser {
    // 整个「读-查重-写」必须在事务里。两个并发请求（一个改昵称、一个改简介）
    // 各自读到旧 user 再整体展开覆写时，后写的会把先写的改动抹掉；
    // 昵称查重与写入之间也有 TOCTOU：两人可同时通过查重拿到同一个昵称。
    return this.store.transaction(() => {
      const user = this.requireUser();
      const nickname = input.nickname;
      // avatar 只认预设集合里的标识。库里的历史脏值（外链/任意串）在写入时被
      // 这种校验挡住；读侧由前端兜底（认不出的按默认画）。
      // 空串 = 恢复默认。预设集合外的任何值都拒绝。
      if (input.avatar !== undefined && input.avatar !== '' && !AVATAR_PRESETS.some(preset => preset === input.avatar)) {
        throw new ApiError(400, 'INVALID_INPUT', '头像必须是预设集合中的一项');
      }
      if (nickname !== undefined) {
        // 列表和详情只渲染 nickname，不渲染 handle，所以「官方」「管理员」这类
        // 展示名一旦能随便取，就等于可以冒充平台身份做钓鱼。
        if (isReservedNickname(nickname)) {
          throw new ApiError(400, 'INVALID_INPUT', `「${nickname}」是保留身份，请换一个昵称`);
        }
        // 与站内其他用户重名同样会让人分不清谁是谁；注册时也走这条。
        // 归一后再比：只 trim+lowercase 时「管理员」和「管理员\u200B」会被当成两个名字。
        const wantedKey = normalizeNickname(nickname);
        const taken = this.store.all('user').find(other => other.handle !== this.user
          && normalizeNickname(other.nickname) === wantedKey);
        if (taken) throw new ApiError(409, 'NICKNAME_TAKEN', '这个昵称已被使用，请换一个');
      }
      this.store.put('user', this.user, { ...user, ...input });
      return this.getMe();
    });
  }

  checkIn(): CheckInResponse {
    return this.store.transaction(() => {
      const me = this.getMe();
      if (me.checkedInToday) throw new ApiError(409, 'ALREADY_CHECKED_IN', '今天已经签到过了');
      const streak = me.streak + 1;
      const tokensAwarded = 10 + Math.min(streak, 7);
      const date = shanghaiDate.format(this.now());
      this.store.db.prepare('INSERT INTO checkins (userHandle,date,tokensAwarded,streak) VALUES (?,?,?,?)').run(this.user, date, tokensAwarded, streak);
      const user = this.requireUser();
      this.store.put('user', this.user, { ...user, tokens: user.tokens + tokensAwarded });
      return { userHandle: this.user, date, tokensAwarded, streak, tokens: user.tokens + tokensAwarded, checkedInToday: true };
    });
  }

  /**
   * 「我的投稿」：文章、模型、站点三类放在一起，带状态和驳回理由。
   *
   * 之前只有 `getMyPosts` 查文章，作者补录模型或推荐站点之后在站内查不到
   * 任何结果——那两条通道照样会驳回、照样会写理由，但提交人看不到。
   * 这个接口直接读 submissions，三类一视同仁。
   *
   * 只读 channel='web'：飞书同步的内容来源是表格，Agent 投稿有自己的
   * `/api/agent/status` 列表和凭证语义，混进来会把内部 originKey 暴露出去。
   */
  getMySubmissions(query: PaginationQuery) {
    const rows = this.store.db.prepare(
      `SELECT id, kind, status, reason, payload, createdAt, reviewedAt
       FROM submissions WHERE channel = 'web' AND actorHandle = ?
       ORDER BY createdAt DESC, rowid DESC`,
    ).all(this.user) as unknown as {
      id: string; kind: 'station' | 'model' | 'post'; status: SubmissionStatus; reason: string | null;
      payload: string; createdAt: string; reviewedAt: string | null;
    }[];
    // 物化后的 slug 要按各自的规则查，不能从 payload 里猜：
    // 文章 id 是 `sub-<投稿id>`（见 submissions.ts 的 materialize），
    // 站点 slug 由 hostname 决定而不是 originKey，模型 slug 就是 payload.slug。
    const items = rows.map((row) => {
      const payload = JSON.parse(row.payload) as { title?: string; name?: string; slug?: string };
      const targetSlug = this.materializedSlug(row, payload);
      return {
        id: row.id, kind: row.kind, status: row.status, reason: row.reason ?? null,
        title: payload.title ?? payload.name ?? payload.slug ?? row.id,
        createdAt: row.createdAt, reviewedAt: row.reviewedAt ?? null,
        targetSlug,
        // 已通过却拿不到链接 = 曾经上线、现在被撤下/下架了。区分出来，
        // 否则前端只能显示「已通过」而没有任何链接，作者会以为撤下没生效。
        ...(row.status === 'approved' && targetSlug === null ? { withdrawn: true } : {}),
      };
    });
    return paginate(items, query);
  }

  /** 只对已通过的投稿算：待审/被拒的还没物化，给了链接也是 404。 */
  private materializedSlug(
    row: { id: string; kind: string; status: string },
    payload: { slug?: string; url?: string },
  ): string | null {
    if (row.status !== 'approved') return null;
    if (row.kind === 'model') return payload.slug ?? null;
    // 文章：站内投稿（channel=web）直接用自己的 id 当文章 id；
    // 飞书/Agent 走 `sub-<投稿id>` 或 `feishu-<originKey>`（见 submissions.ts 的 materialize）。
    // 这里只服务 web 渠道，所以就是投稿 id 本身——但仍要确认实体真的存在，
    // 否则给出去的是一个 404 链接。
    if (row.kind === 'post') return this.store.get('post', row.id) ? row.id : null;
    // 站点：slug 由 hostname 决定，用同一个 hostnameOf 重新算一遍再查。
    const hostname = hostnameOf(payload.url ?? null);
    if (hostname === null) return null;
    const found = this.store.all('station').find(station => hostnameOf(station.url ?? null) === hostname);
    return found?.slug ?? null;
  }

  getMyPosts(query: PaginationQuery) {
    // 原来是 `store.all('post')` 全量反序列化再在 JS 里按作者过滤：
    // 2 万篇文章时 280~650ms，只为了取出自己的那几十篇。作者已有表达式索引
    // （entities_post_author），直接下推给 SQLite。
    const approved = this.store.db.prepare(
      `SELECT data FROM entities WHERE ${POST_AUTHOR} AND removedAt IS NULL ORDER BY rowid`,
    ).all(this.user).map(row => JSON.parse(row.data as string) as PostRecord);
    // 加上还在队列里的待审稿：站内发帖已走统一队列，
    // 不列出来作者会以为投稿丢了。
    // 待审与被拒的都列出来：被拒也是作者的记录，他要能看到状态和原因。
    const pending = this.store.db.prepare(
      "SELECT * FROM submissions WHERE kind = 'post' AND channel = 'web' AND actorHandle = ? AND status IN ('pending','rejected')",
    ).all(this.user).map(row => this.queuedPost(row));
    const posts = [...approved, ...pending]
      .sort((a, b) => comparePublishedAt(b.publishedAt, a.publishedAt)).map(p => this.post(p));
    return paginate(posts, query);
  }

  getVendors(query: PaginationQuery) {
    const models = this.store.all('model');
    const vendors: VendorWithModels[] = this.store.all('vendor').map(v => ({ ...v, models: models.filter(m => m.vendor === v.slug) }));
    return paginate(vendors, query);
  }

  getModels(query: GetModelsRequest) {
    return paginate(this.store.all('model').filter(m => (!query.vendor || m.vendor === query.vendor) && matches(query.q, m.name, m.slug, m.description, ...m.tags)), query);
  }

  getModel(slug: string): ModelDetail {
    const model = this.store.get('model', slug);
    if (!model) throw new ApiError(404, 'NOT_FOUND', '模型不存在');
    // 一个模型可能有几十上百条报价行，每行各查三张互动表就是上百条 SQL，
    // 所以预取。但预取是扫**全站**的票/收藏/评论，成本跟要展示的报价条数无关——
    // 16 个站点挂这个模型时全量预取 6ms、400 个站点时 59ms，而点查只有十几条 SQL。
    // 实测报价条数达到阈值以上，预取才开始划算。
    const ratedStations = this.offers().reduce((count, offer) => count + Number(offer.modelSlug === slug), 0);
    const interactions = ratedStations >= PREFETCH_MIN_ROWS ? this.interactionMap('station') : null;
    const offers = sortOffersForDisplay(this.offers().filter(o => o.modelSlug === slug))
      // 站点已被下架时报价不该出现；用 filter 兜底而不是非空断言，
      // 一条孤儿报价不能把整个模型页变成 500。
      .flatMap(o => { const station = this.store.get('station', o.stationSlug); return station ? [{ ...o, station: this.station(station, interactions ?? undefined) }] : []; });
    return { ...model, offers };
  }

  getStations(query: GetStationsRequest) {
    const vendorModels = new Set(this.store.all('model').filter(m => m.vendor === query.vendor).map(m => m.slug));
    const offers = this.offers();
    const vendorStations = new Set(offers.filter(o => vendorModels.has(o.modelSlug)).map(o => o.stationSlug));
    // 这里先留在记录层：score 依赖互动数，排序要用它，所以不能先转 DTO 再排序。
    const records = this.store.all('station').filter(s => (!query.vendor || vendorStations.has(s.slug)) && matches(query.q, s.name, s.slug, s.description));
    // 同理：站点数量少时逐条点查更便宜，几十个以上才值得全量聚合。
    const interactions = records.length >= PREFETCH_MIN_ROWS ? this.interactionMap('station') : null;
    const lastConfirmed = this.lastConfirmedMap();
    const items = records.map(s => this.station(s, interactions ?? undefined, lastConfirmed));
    if (query.sort === 'rate') {
      const offersByStation = new Map<string, StationOffer[]>();
      for (const offer of offers) {
        // 同样用 push：`[...existing, offer]` 在单个站点报价很多时是 O(r²)。
        const bucket = offersByStation.get(offer.stationSlug);
        if (bucket) bucket.push(offer); else offersByStation.set(offer.stationSlug, [offer]);
      }
      items.sort((a, b) => {
        const aOffers = offersByStation.get(a.slug) ?? [];
        const bOffers = offersByStation.get(b.slug) ?? [];
        // 没有综合口径报价的站（lowestRate === null）无条件排在最后：
        // 它没有能和别人比较的价格，放在前面等于替读者主张「这站最便宜」。
        // 最后用 slug 兜底，让比较器成为**严格全序**：两个站既没有可比价格、
        // 门槛分组又相同时，返回 0 就把顺序交给了插入顺序（依赖 SQLite rowid 与
        // V8 stable sort 的实现细节）。分页时这种隐式顺序最容易变成「第 2 页
        // 出现第 1 页的条目」，而这里偏偏是会让人看价格的页面。
        const aRate = a.lowestRate, bRate = b.lowestRate;
        if (aRate === null || bRate === null) return Number(bRate !== null) - Number(aRate !== null) || a.slug.localeCompare(b.slug);
        return Number(this.hasEnoughOffersForRate(bOffers)) - Number(this.hasEnoughOffersForRate(aOffers))
          || aRate - bRate
          || a.slug.localeCompare(b.slug);
      });
    } else {
      // 同值时必须按 slug 兜底：光靠 descendingNullsLast 返回 0，会让顺序依赖
      // 插入顺序（SQLite rowid + V8 stable sort），全量导入重建后同一批站可能在
      // 分页间换位置——第 1 页出现第 2 页的条目。
      items.sort((a, b) => (query.sort === 'uptime'
        ? descendingNullsLast(a.uptime, b.uptime)
        : descendingNullsLast(a.score, b.score)) || a.slug.localeCompare(b.slug));
    }
    return paginate(items, query);
  }

  getStation(slug: string): StationDetail {
    const station = this.store.get('station', slug);
    if (!station) throw new ApiError(404, 'NOT_FOUND', '中转站不存在');
    // 和模型页同一套顺序，见 sortOffersForDisplay。
    // lastConfirmedMap 必须传：不传的话列表页有时间、详情页是 null，同一份数据两处不一致。
    return { ...this.station(station, undefined, this.lastConfirmedMap()), offers: sortOffersForDisplay(this.offers().filter(o => o.stationSlug === slug))
      .flatMap(o => { const model = this.store.get('model', o.modelSlug); return model ? [{ ...o, model }] : []; }) };
  }

  /**
   * 一次性取出某类目标的净票数（up - down），供 hot 排序使用。
   *
   * 原先排序时每条都组装成 DTO，等于每篇文章各查一次票数与收藏与评论数；
   * hot 只需要净票数，一条 GROUP BY 就够，排序阶段不必碰互动明细。
   */
  private netVotes(targetType: Target['targetType']): Map<string, number> {
    const rows = this.store.db.prepare(
      `SELECT targetId, SUM(CASE WHEN value = 'up' THEN 1 ELSE -1 END) AS net
       FROM votes WHERE targetType = ? GROUP BY targetId`,
    ).all(targetType) as { targetId: string; net: number }[];
    return new Map(rows.map(row => [row.targetId, Number(row.net)]));
  }

  /** 某类型目标的某方向票数，一条 GROUP BY。 */
  private countVotes(targetType: Target['targetType'], value: 'up' | 'down'): Map<string, number> {
    const rows = this.store.db.prepare(
      'SELECT targetId, count(*) AS count FROM votes WHERE targetType = ? AND value = ? GROUP BY targetId',
    ).all(targetType, value) as { targetId: string; count: number }[];
    return new Map(rows.map(row => [row.targetId, Number(row.count)]));
  }

  /** 某类型目标各自的可见评论数，一条 GROUP BY。 */
  private countComments(targetType: Target['targetType']): Map<string, number> {
    const rows = this.store.db.prepare(
      `SELECT targetId, count(*) AS count FROM comments WHERE targetType = ? AND ${COMMENT_VISIBLE} GROUP BY targetId`,
    ).all(targetType) as { targetId: string; count: number }[];
    return new Map(rows.map(row => [row.targetId, Number(row.count)]));
  }

  private hotScoreRecord(post: PostRecord, net: number): number {
    const ageHours = Math.max(0, (this.now().getTime() - Date.parse(post.publishedAt)) / 3600000);
    return net / Math.pow(ageHours + 2, 1.3);
  }

  getPosts(query: GetPostsRequest) {
    const models = new Set(this.store.all('model').filter(m => m.vendor === query.vendor).map(m => m.slug));
    // 排序键（publishedAt、hot 分数）都来自记录本身，不需要组装 DTO，
    // 所以组装推迟到切片之后——否则每次请求都会把全库文章各查一遍互动数据。
    const records = this.approvedPosts().filter(p =>
      (!query.author || p.authorHandle === query.author) &&
      (!query.kind || p.kind === query.kind) && (!query.station || p.stationSlug === query.station) &&
      (!query.model || p.modelSlug === query.model) && (!query.vendor || (p.modelSlug !== null && models.has(p.modelSlug))) &&
      matches(query.q, p.title, p.summary, p.body));
    const net = query.sort === 'hot' ? this.netVotes('post') : null;
    records.sort((a, b) => (net
      ? this.hotScoreRecord(b, net.get(b.id) ?? 0) - this.hotScoreRecord(a, net.get(a.id) ?? 0)
      : 0) || comparePublishedAt(b.publishedAt, a.publishedAt));
    // 这里不预取互动数据：组装被推迟到切片之后，只需按 id 点查本页那 20 条。
    //
    // 实测（2 万篇 × 各 1 票 1 评论）：全量聚合 125ms，点查 20 条 2ms、
    // 点查 100 条 10ms。点查成本只随本页条数增长，与全库无关；聚合要扫整张
    // 表，库一大就是固定的大开销。先前无条件聚合，反而让「搜索只命中 1 篇」
    // 「按站点过滤剩 20 篇」这些路径从 130ms 变成 322ms。
    return paginateThen(records, query, record => this.post(record));
  }

  /**
   * 站点页一句话反馈：三个选项 + 一句话。
   *
   * 为什么单独开一条而不是复用评论：评论是「讨论」，有回复、有层级、可以为了一
   * 个观点写几百字；反馈是「签到」——充了 10 块、第二天 502，读者能给的往往
   * 就这么多。混在一起会让评论区变成一堆彼此无关的短句。
   *
   * 配额有两层，都是必要的：
   * - 每小时 5 条：挡住瞬间刷屏；
   * - 每天 20 条：挡不住一小时 5 条、一天 120 条的慢速刷法。
   * 另外同一人对同一站每天只能发一条：这类信息本来就是「我今天试了」。
   */
  createFeedback(input: CreateFeedbackRequest): Feedback {
    const station = this.store.get('station', input.stationSlug);
    if (!station) throw new ApiError(404, 'NOT_FOUND', '站点不存在');
    if (station.source === 'demo') throw new ApiError(400, 'INVALID_INPUT', '演示站点不需要反馈');
    const content = input.content.trim();
    if (!content) throw new ApiError(400, 'INVALID_INPUT', '写一句话再提交');
    if (content.length > FEEDBACK_MAX_LENGTH) throw new ApiError(400, 'INVALID_INPUT', `一句话最多 ${FEEDBACK_MAX_LENGTH} 字`);

    const now = this.now();
    const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
    const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
    // 配额一律数**含墓碑**的行：作者删掉不该把额度退回来，否则
    // 「提交 → 删除 → 再提交」就能无限刷，一次删除等于一次配额重置。
    const count = (since: string, extra = '', params: string[] = []) => Number(this.store.db.prepare(
      `SELECT count(*) AS count FROM feedback WHERE userHandle = ? AND createdAt > ?${extra}`,
    ).get(this.user, since, ...params)!.count);
    const id = crypto.randomUUID();
    const createdAt = now.toISOString();
    // 检查与写入放在同一个写事务里：分开做的话，两个并发请求会同时看到
    // 「还没到上限」然后各写一条，实际写进去两条。
    this.store.transaction(() => {
      if (count(hourAgo) >= FEEDBACK_PER_HOUR) throw new ApiError(429, 'RATE_LIMITED', '反馈太频繁了，请稍后再试');
      if (count(dayAgo) >= FEEDBACK_PER_DAY) throw new ApiError(429, 'RATE_LIMITED', '今天反馈得够多了，明天再来');
      if (count(dayAgo, ' AND stationSlug = ?', [input.stationSlug]) > 0) {
        throw new ApiError(409, 'ALREADY_FEEDBACK', '今天已经给这个站留过一句话了');
      }
      this.store.db.prepare(
        'INSERT INTO feedback (id,stationSlug,userHandle,verdict,content,createdAt,deletedAt) VALUES (?,?,?,?,?,?,NULL)',
      ).run(id, input.stationSlug, this.user, input.verdict, content, createdAt);
    });
    // verified:false 是契约的一部分：这句话是用户自述，不是平台实测。
    // 响应里显式带上，消费方（含 Agent）不会把它当成测过的结论。
    return { id, stationSlug: input.stationSlug, author: this.author(this.user), verdict: input.verdict, content, createdAt, mine: true, verified: false };
  }

  getFeedback(query: GetFeedbackRequest) {
    // 分页交给 SQL：原先把整站反馈读进内存再 slice，条数一多就是全表扫描 + 全量反序列化。
    // 分页上限由路由的 zod schema 负责（pageSize 封顶 50），这里不重复夹。
    const pageSize = query.pageSize ?? 20;
    const page = query.page ?? 1;
    const total = Number(this.store.db.prepare(
      'SELECT count(*) AS count FROM feedback WHERE stationSlug = ? AND deletedAt IS NULL',
    ).get(query.stationSlug)!.count);
    const rows = this.store.db.prepare(
      `SELECT id, stationSlug, userHandle, verdict, content, createdAt FROM feedback
       WHERE stationSlug = ? AND deletedAt IS NULL
       ORDER BY createdAt DESC, rowid DESC LIMIT ? OFFSET ?`,
    ).all(query.stationSlug, pageSize, (page - 1) * pageSize) as Array<{
      id: string; stationSlug: string; userHandle: string; verdict: FeedbackVerdict; content: string; createdAt: string;
    }>;
    const items = rows.map(row => ({
      id: row.id, stationSlug: row.stationSlug, author: this.author(row.userHandle),
      verdict: row.verdict, content: row.content, createdAt: row.createdAt, mine: row.userHandle === this.user,
      verified: false as const,
    })) satisfies Feedback[];
    return { items, total, page, pageSize };
  }

  deleteFeedback(id: string): { id: string; deleted: true } {
    const row = this.store.db.prepare('SELECT userHandle, deletedAt FROM feedback WHERE id = ?').get(id) as
      { userHandle: string; deletedAt: string | null } | undefined;
    // 找不到也回 404：不区分「不存在」和「不是你的」，否则 id 又变成存在性探针。
    if (!row || row.userHandle !== this.user) throw new ApiError(404, 'NOT_FOUND', '反馈不存在');
    // 幂等：删两次都返回成功，第二次不改时间。
    if (row.deletedAt === null) {
      this.store.db.prepare('UPDATE feedback SET deletedAt = ? WHERE id = ?').run(this.now().toISOString(), id);
    }
    return { id, deleted: true };
  }

  /**
   * 公开作者主页。只给本来就公开的东西：昵称、头像、简介、篇数、获赞数、注册时间。
   *
   * 不存在的作者回 404 而不是「空主页」：空主页会让每个拼错的 handle 都变成一个
   * 看起来正常的页面，也让「这个人有没有账号」变成可枚举的。
   */
  getUser(handle: string): PublicProfile {
    const user = this.store.get('user', handle);
    if (!user) throw new ApiError(404, 'NOT_FOUND', '没有这个作者');
    const posts = this.approvedPosts().filter(post => post.authorHandle === handle);
    const up = this.countVotes('post', 'up');
    let upCount = 0;
    for (const post of posts) upCount += up.get(post.id) ?? 0;
    // 注册时间在 accounts 表（凭证）而不是 entities 的 data 里：后者只有
    // handle/nickname/avatar/bio/tokens，没有注册时间。
    const account = this.store.db.prepare('SELECT createdAt FROM accounts WHERE handle = ?').get(handle) as { createdAt: string } | undefined;
    return {
      handle: user.handle, nickname: user.nickname, avatar: user.avatar, bio: user.bio,
      shareCount: posts.length, upCount, joinedAt: account?.createdAt ?? null,
    };
  }

  getPost(id: string): Post {
    const post = this.readablePost(id);
    if (!post) throw new ApiError(404, 'NOT_FOUND', '文章不存在');
    return this.post(post, undefined, true);
  }

  // 这里原先有个 createPost()，直接 store.put 一篇 pending 文章，绕过投稿队列。
  // 公开路由 POST /api/posts 已经改成走 enqueueSubmission，它就再也没被调用过——
  // 留着是一颗地雷：谁哪天顺手调它，就绕过了审核队列、飞书去重和下架版本校验，
  // 而且是静默的。删掉，让「站内投稿只走队列」变成结构上的事实。
  // 提交后的回显由 pendingPost(submission) 负责。

  putVote(input: PutVoteRequest): PutVoteResponse {
    this.requireTarget(input);
    const { targetType, targetId, value } = input;
    if (value === null) this.store.db.prepare('DELETE FROM votes WHERE userHandle=? AND targetType=? AND targetId=?').run(this.user, targetType, targetId);
    else this.store.db.prepare('INSERT INTO votes (userHandle,targetType,targetId,value) VALUES (?,?,?,?) ON CONFLICT(userHandle,targetType,targetId) DO UPDATE SET value=excluded.value').run(this.user, targetType, targetId, value);
    const { votes, currentUserVote } = this.interaction(input);
    return { targetType, targetId, votes, currentUserVote };
  }

  putFavorite(input: PutFavoriteRequest): PutFavoriteResponse {
    this.requireTarget(input);
    const { targetType, targetId, favorited } = input;
    if (favorited) this.store.db.prepare('INSERT INTO favorites (userHandle,targetType,targetId,createdAt) VALUES (?,?,?,?) ON CONFLICT DO NOTHING').run(this.user, targetType, targetId, this.now().toISOString());
    else this.store.db.prepare('DELETE FROM favorites WHERE userHandle=? AND targetType=? AND targetId=?').run(this.user, targetType, targetId);
    return { targetType, targetId, favorited, favoriteCount: this.interaction(input).favoriteCount };
  }

  getComments(query: GetCommentsRequest) {
    this.requireTarget(query);
    const rows = this.store.db.prepare('SELECT id,userHandle,targetType,targetId,content,parentId,createdAt,deletedAt FROM comments WHERE targetType=? AND targetId=? AND hidden = 0 ORDER BY createdAt DESC, rowid DESC').all(query.targetType, query.targetId) as unknown as CommentRow[];
    // 回复按父评论分组，不要对每条顶层评论重扫一遍全部行：
    // 那是 O(顶层数 × 总行数)，一条热帖几百条评论时会明显卡。
    const repliesByParent = new Map<string, CommentRow[]>();
    for (const row of rows) {
      if (row.parentId === null) continue;
      // 用 push 追加，不要每次 `[...existing, row]`：那种写法在单个父评论
      // 有 r 条回复时是 O(r²)，热门帖反而比改之前的 O(n) 更慢。
      const bucket = repliesByParent.get(row.parentId);
      if (bucket) bucket.push(row); else repliesByParent.set(row.parentId, [row]);
    }
    // 墓碑只在「下面还挂着别人的回复」时才值得显示——那时它提供的是上下文
    // （这几条回复是在回什么）。没有可见回复的空墓碑等于一条空白评论，
    // 直接从列表里去掉，别让读者以为是加载失败。
    const tops = rows.filter(row => row.parentId === null && (!row.deletedAt || (repliesByParent.get(row.id)?.length ?? 0) > 0));
    // 先切页再组装：回复可能很多，没必要把后面几页的全部装配出来再丢掉。
    return paginateThen(tops, query, row => ({
      ...this.comment(row), parentId: null,
      replies: (repliesByParent.get(row.id) ?? []).reverse().map(reply => ({ ...this.comment(reply), parentId: row.id })),
    }));
  }

  private comment(row: CommentRow) {
    const { userHandle, deletedAt, content, ...fields } = row;
    // deletedAt 不外泄成时间戳，只暴露一个布尔 —— 前端要的是「显示成已删除」，
    // 精确到秒的删除时间没有用处，反而让人以为能查到操作记录。
    //
    // 墓碑的正文在库里保留（举报处理要看原文），但**对外一律为空串**：
    // 作者删掉的话不该还能被任何人读到。
    return { ...fields, content: deletedAt ? '' : content, author: this.author(userHandle), ...(deletedAt ? { deleted: true } : {}) };
  }

  createComment(input: CreateCommentRequest): Comment | CommentReply {
    this.requireTarget(input);
    const since = new Date(this.now().getTime() - 60_000).toISOString();
    const recent = Number(this.store.db.prepare('SELECT count(*) AS count FROM comments WHERE userHandle=? AND createdAt > ?').get(this.user, since)!.count);
    if (recent >= COMMENTS_PER_MINUTE) throw new ApiError(429, 'RATE_LIMITED', '评论太频繁了，请稍后再试');
    if (input.parentId) {
      const parent = this.store.db.prepare('SELECT targetType,targetId,parentId FROM comments WHERE id=? AND hidden = 0 AND deletedAt IS NULL').get(input.parentId);
      if (!parent || parent.parentId !== null || parent.targetType !== input.targetType || parent.targetId !== input.targetId) throw new ApiError(400, 'INVALID_INPUT', '回复必须属于同一对象的顶层评论');
    }
    const row: CommentRow = { ...input, id: crypto.randomUUID(), userHandle: this.user, parentId: input.parentId ?? null, createdAt: this.now().toISOString() };
    this.store.db.prepare('INSERT INTO comments (id,userHandle,targetType,targetId,content,parentId,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(row.id, row.userHandle, row.targetType, row.targetId, row.content, row.parentId, row.createdAt);
    return row.parentId === null ? { ...this.comment(row), parentId: null, replies: [] } : { ...this.comment(row), parentId: row.parentId };
  }

  /**
   * 举报一处内容。
   *
   * 这个功能只做「让人能说出来」，不做自动处置：举报零成本，自动下架等于
   * 一次点击删一篇文章，而没有任何复核。处置入口在管理台，由人看。
   *
   * 三条限制是有意的：
   * - 不能举报自己的内容（那不是举报，是撤下，走 deletePost/deleteComment）；
   * - 不能举报看不见的对象（否则可以用它探测哪些 id 存在）；
   * - 演示数据不能举报（虚构样例，运营侧清库，不归读者管）。
   */
  createReport(input: CreateReportRequest) {
    // 先看配额再查目标：否则刷屏者的探测请求也会打到实体查找上。
    const since = new Date(this.now().getTime() - 3_600_000).toISOString();
    const recent = Number(this.store.db.prepare('SELECT count(*) AS count FROM reports WHERE reporterHandle = ? AND createdAt > ?').get(this.user, since)!.count);
    if (recent >= REPORTS_PER_HOUR) throw new ApiError(429, 'RATE_LIMITED', '举报太频繁了，请稍后再试');
    const targetType = input.targetType;
    if (targetType === 'post') {
      const post = this.readablePost(input.targetId);
      if (!post) throw new ApiError(404, 'NOT_FOUND', '内容不存在');
      if (post.authorHandle === this.user) throw new ApiError(400, 'INVALID_INPUT', '不能举报自己发布的内容');
      // 演示文章没有处置出口（下架接口对 demo 回 409），举报了也只能挂着。
      if (post.source === 'demo') throw new ApiError(400, 'INVALID_INPUT', '演示数据不需要举报');
    } else if (targetType === 'station') {
      const station = this.store.get('station', input.targetId);
      if (!station) throw new ApiError(404, 'NOT_FOUND', '内容不存在');
      if (station.source === 'demo') throw new ApiError(400, 'INVALID_INPUT', '演示数据不需要举报');
    } else {
      // 隐藏的和已删除（墓碑）的评论都不能举报：读者根本看不到它们，
      // 允许举报等于把评论 id 变成一个存在性探针；而且也没法处理——内容已经不在。
      const comment = this.store.db.prepare('SELECT userHandle, targetType, targetId FROM comments WHERE id = ? AND hidden = 0 AND deletedAt IS NULL').get(input.targetId) as
        { userHandle: string; targetType: 'post' | 'station'; targetId: string } | undefined;
      if (!comment) throw new ApiError(404, 'NOT_FOUND', '内容不存在');
      if (comment.userHandle === this.user) throw new ApiError(400, 'INVALID_INPUT', '不能举报自己发布的评论');
      // 评论所属的对象也得还在线：文章撤下后，其评论在详情里已经读不到，
      // 举报它同样没有处置出口。
      const ownerVisible = comment.targetType === 'post'
        ? this.readablePost(comment.targetId) !== undefined
        : this.store.get('station', comment.targetId) !== undefined;
      if (!ownerVisible) throw new ApiError(404, 'NOT_FOUND', '内容不存在');
      // 注意这里**不看**所属对象是不是演示数据：演示站下面挂着的是真实用户评论，
      // 而评论本身有处置路径（管理员可以隐藏它），所以举报是有出口的。
      // 只有「举报的对象本身就是虚构内容」才拒绝（文章、站点）。
    }
    const reason = input.reason.trim();
    if (!reason) throw new ApiError(400, 'INVALID_INPUT', '请选择或填写举报原因');
    // 已经被判定「不成立」的同一条内容，同一个人不能反复再报。
    //
    // 部分唯一索引只管 status='open'，所以处置完之后可以立刻再报一次——同一个人
    // 对同一条内容可以无限次刷，每次都给管理台加一条一模一样的待办。
    // 而「不成立」意味着管理员已经看过、认定没问题；本站内容目前**不可编辑**
    // （文章编辑还没做），所以重复举报不可能带来新信息。
    //
    // 注意：将来支持文章编辑后，这里必须再加一条「目标在这次处置之后没被改过」
    // 的判断，否则改了内容就不许再报，等于把回归问题锁死。
    const dismissed = this.store.db.prepare(
      "SELECT id FROM reports WHERE targetType = ? AND targetId = ? AND reporterHandle = ? AND status = 'dismissed' LIMIT 1",
    ).get(targetType, input.targetId, this.user);
    if (dismissed) throw new ApiError(409, 'ALREADY_DISMISSED', '你举报过这条内容，管理员已判定不成立；如果情况有变，请站内联系管理员');
    const id = crypto.randomUUID();
    const now = this.now().toISOString();
    try {
      this.store.db.prepare(
        'INSERT INTO reports (id,targetType,targetId,reporterHandle,reason,detail,status,createdAt) VALUES (?,?,?,?,?,?,?,?)',
      ).run(id, targetType, input.targetId, this.user, reason.slice(0, 200), input.detail?.trim().slice(0, 500) ?? null, 'open', now);
    } catch (error) {
      // 部分唯一索引挡住重复举报。回 409 而不是静默成功：用户应该知道
      // 「已经报过了」，而不是以为又报了一次、等着第二个处理结果。
      if (isDatabaseBusyError(error)) throw error;
      if (isUniqueConstraintError(error)) {
        throw new ApiError(409, 'ALREADY_REPORTED', '你已经举报过这条内容，我们会在处理时一并看到');
      }
      throw error;
    }
    return { id, status: 'open' as const };
  }

  /**
   * 作者撤下自己发布过的文章（软删除）。
   *
   * 「投稿可以，撤稿不行」是不对称的：作者看到自己的字挂在那儿、发现写错了或
   * 后悔了，唯一的出路是找管理员。撤下是软删除（removedAt），正文一直在库里，
   * 管理员随时能恢复——所以给作者这个权力并不会造成不可挽回的损失。
   *
   * 恢复刻意只留给管理员：作者自己的撤下是「我想让它下线」，如果他自己又能
   * 一键恢复，那就等于没有撤下。误操作靠确认弹窗拦截，真需要救回时找管理员。
   */
  withdrawOwnPost(id: string) {
    // 用 getWithRemoved：已经撤下的要报「已撤下」而不是「不存在」，
    // 否则作者会以为文章被人删了。
    const post = this.store.getWithRemoved('post', id);
    if (!post) {
      // 站内投稿物化前只存在于队列里。作者在「我的分享」看到它、
      // 想撤下时，回「文章不存在」会让人以为稿子丢了。
      const queued = this.store.db.prepare(
        "SELECT status FROM submissions WHERE id = ? AND kind = 'post' AND channel = 'web' AND actorHandle = ?",
      ).get(id, this.user) as { status: string } | undefined;
      if (queued) throw new ApiError(409, 'POST_NOT_PUBLISHED', '这条投稿还在队列里，没有上线也就没有「撤下」；审核通过后可以撤下');
      throw new ApiError(404, 'NOT_FOUND', '文章不存在');
    }
    // 不是自己的文章一律 404：403 会承认「这篇存在但不是你的」。
    if (post.authorHandle !== this.user) throw new ApiError(404, 'NOT_FOUND', '文章不存在');
    if (post.source === 'demo') throw new ApiError(409, 'POST_SOURCE_CONFLICT', '演示数据不能撤下');
    if (post.status !== 'approved') {
      // 待审/被拒的还没上线，没有「撤下」可言；它们该被重投覆盖或不管。
      throw new ApiError(409, 'POST_NOT_PUBLISHED', '只有已通过审核的文章才能撤下');
    }
    if (!this.store.markRemoved('post', id, this.now().toISOString())) {
      throw new ApiError(409, 'ALREADY_REMOVED', '这篇文章已经撤下了');
    }
    return { id, removed: true as const };
  }

  /**
   * 作者删除自己的评论。
   *
   * 分两种情况：
   * - **没有子行**：直接物理删。留墓碑只会让读者点进来发现一条空评论。
   * - **有子行**：只能留墓碑（正文清空 + `deletedAt`）。`PRAGMA foreign_keys = ON`
   *   会对 `parentId` 生效，而且外键**不看 `hidden`**——被管理员隐藏的回复一样
   *   引用着这条父评论。所以判断必须用「是否存在任何子行」，用「可见子回复」
   *   会漏掉隐藏的那些，删除时直接撞约束失败。
   *
   * 别人回复的内容不跟着消失：那是他们写的话，不该因为父评论作者删了帖就一起没。
   */
  deleteComment(id: string) {
    const row = this.store.db.prepare('SELECT id, userHandle FROM comments WHERE id = ?').get(id) as
      { id: string; userHandle: string } | undefined;
    // 不是自己的评论一律 404：回 403 等于告诉对方「这个 id 存在但不是你的」。
    if (!row || row.userHandle !== this.user) throw new ApiError(404, 'NOT_FOUND', '评论不存在');
    const children = Number(this.store.db.prepare('SELECT count(*) AS count FROM comments WHERE parentId = ?').get(id)!.count);
    // 管理员已经隐藏、或正处于举报处理中时，物理删会把审核证据一起删掉
    // （reports 表只存 id，不存正文快照）。这种情况一律留墓碑：
    // 读者看到的仍是「已删除」，库里的原文保留给处理举报的人。
    const row2 = this.store.db.prepare('SELECT hidden FROM comments WHERE id = ?').get(id) as { hidden: number };
    const reported = this.store.db.prepare(
      "SELECT 1 FROM reports WHERE targetType = 'comment' AND targetId = ? AND status = 'open' LIMIT 1",
    ).get(id) !== undefined;
    const mustKeep = children > 0 || Number(row2.hidden) === 1 || reported;
    if (mustKeep) {
      // 已经是墓碑就当作成功，重复点不该报错。
      this.store.db.prepare('UPDATE comments SET deletedAt = COALESCE(deletedAt, ?) WHERE id = ?')
        .run(this.now().toISOString(), id);
      return { id, deleted: 'tombstoned' as const };
    }
    this.store.db.prepare('DELETE FROM comments WHERE id = ?').run(id);
    return { id, deleted: 'removed' as const };
  }

  getRankings(query: GetRankingsRequest): GetRankingsResponse {
    if (query.tab === 'model') {
      // 一次分组算出「每个模型的报价条数与最低倍率」，而不是对每个模型都
      // filter 一遍全部报价（那是 O(模型数×报价数)：500 站时 34 次 filter 占 215ms）。
      // 这里只需要条数和最小值，没必要把匹配的数组留下来。
      // count 数所有口径（它表示「有多少站在报这个模型」），但 lowest 只算综合口径——
      // 模型榜的 1/lowestRate 是加分项，混入口径后「按输入 0.1」的站会把整模型顶上去，
      // 而那个数字只对输入 token 成立。没有任何综合口径报价时 lowest 保持 Infinity，
      // 下面据此返回 null（而不是 Infinity 泄漏到 JSON 里）。
      // count 数全部口径（它是「多少站在报这个模型」，展示用）；
      // blendedCount 数综合口径，门槛与最低倍率都只认它——两处口径必须一致，
      // 否则会出现「够格参与低价加成、却算不出可比最低价」的自相矛盾状态。
      const stats = new Map<string, { count: number; blendedCount: number; lowest: number }>();
      for (const offer of this.offers()) {
        const blended = (offer.basis ?? 'blended') === 'blended';
        const current = stats.get(offer.modelSlug);
        if (current === undefined) {
          stats.set(offer.modelSlug, { count: 1, blendedCount: blended ? 1 : 0, lowest: blended ? offer.rate : Number.POSITIVE_INFINITY });
        } else {
          current.count += 1;
          if (blended) {
            current.blendedCount += 1;
            if (offer.rate < current.lowest) current.lowest = offer.rate;
          }
        }
      }
      const items = this.store.all('model').map(model => {
        const stat = stats.get(model.slug);
        return {
          rank: 0, model,
          lowestRate: stat && Number.isFinite(stat.lowest) ? stat.lowest : null,
          stationCount: stat ? stat.count : 0,
          rateEligible: (stat?.blendedCount ?? 0) >= MIN_OFFERS_FOR_RATE,
        };
      });
      // 至少三个站点报价才启用低价加成，避免单条低价决定榜单。
      const score = (item: typeof items[number]) => item.stationCount + (item.rateEligible && item.lowestRate !== null ? 1 / item.lowestRate : 0);
      items.sort((a, b) => Number(b.rateEligible) - Number(a.rateEligible) || score(b) - score(a));
      const ranked = items.slice(0, 12).map(({ rateEligible: _rateEligible, ...item }, index) => ({ ...item, rank: index + 1 }));
      return { tab: 'model', ...paginate(ranked, query) };
    }
    if (query.tab === 'community') {
      // 排序只用「up 数」和「评论数」，不必把每篇文章都组装成 DTO（那是一次全量
      // N+1）；榜单只要前 12 条，组装也只做这 12 条。
      const records = this.approvedPosts().filter(p => p.kind === 'community');
      const up = this.countVotes('post', 'up');
      const comments = this.countComments('post');
      records.sort((a, b) => ((up.get(b.id) ?? 0) * 2 + (comments.get(b.id) ?? 0)) - ((up.get(a.id) ?? 0) * 2 + (comments.get(a.id) ?? 0))
        || comparePublishedAt(b.publishedAt, a.publishedAt));
      return { tab: 'community', ...paginate(records.slice(0, 12).map((record, index) => ({ rank: index + 1, post: this.post(record) })), query) };
    }
    if (query.tab === 'station') {
      // 12 条够用，直接复用 /stations 的 score 排序，避免两处各算一套分。
      const page = this.getStations({ sort: 'score', page: 1, pageSize: 12 });
      return {
        tab: 'station',
        items: page.items.map((station, index) => ({ rank: index + 1, station })),
        total: page.total, page: 1, pageSize: 12,
      };
    }
    // 专家榜同样：up 数与篇数各用一条聚合查询算，再只组装上榜的 12 条。
    const records = this.approvedPosts();
    const up = this.countVotes('post', 'up');
    const byAuthor = new Map<string, { shareCount: number; upCount: number }>();
    for (const record of records) {
      const entry = byAuthor.get(record.authorHandle) ?? { shareCount: 0, upCount: 0 };
      entry.shareCount += 1;
      entry.upCount += up.get(record.id) ?? 0;
      byAuthor.set(record.authorHandle, entry);
    }
    // 只列有公开文章的人，注册本身不会让账号出现在榜单上。
    const items = this.store.all('user').map(user => {
      const stats = byAuthor.get(user.handle) ?? { shareCount: 0, upCount: 0 };
      return { rank: 0, user, shareCount: stats.shareCount, upCount: stats.upCount };
    }).filter(item => item.shareCount > 0).sort((a, b) => b.upCount - a.upCount || b.shareCount - a.shareCount);
    return { tab: 'expert', ...paginate(items.slice(0, 12).map((item, index) => ({ ...item, rank: index + 1 })), query) };
  }

  getBanners(query: PaginationQuery) {
    return paginate(this.store.all('banner'), query);
  }

  search(q: string): SearchResponse {
    return {
      models: this.getModels({ q, pageSize: 10 }).items,
      stations: this.getStations({ q, pageSize: 10 }).items,
      posts: this.getPosts({ q, pageSize: 10 }).items,
    };
  }

  getHotSearches(query: PaginationQuery) {
    return paginate(['DeepSeek', 'Claude', 'GPT', 'Gemini', 'API', 'Token', '倍率', '小额试用'], query);
  }
}

interface CommentRow extends Target {
  id: string;
  userHandle: string;
  content: string;
  parentId: string | null;
  createdAt: string;
  deletedAt?: string | null;
}
