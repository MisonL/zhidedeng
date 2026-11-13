import type {
  Author, CheckInResponse, Comment, CommentReply, CreateCommentRequest, CreatePostRequest,
  CurrentUser, Favorite, FavoriteItem, GetCommentsRequest, GetModelsRequest, GetPostsRequest,
  GetRankingsRequest, GetRankingsResponse, GetStationsRequest, InteractionState, ModelDetail,
  PaginationQuery, Post, PutFavoriteRequest, PutFavoriteResponse, PutVoteRequest, PutVoteResponse,
  SearchResponse, Station, StationDetail, StationOffer, Target, UpdateMeRequest, VendorWithModels, Vote,
} from '@zhidedeng/shared';
import { ApiError } from './errors.ts';
import { Store } from './database.ts';
import type { PostRecord, StationRecord } from './database.ts';

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
const COMMENT_VISIBLE = 'hidden = 0 AND (parentId IS NULL OR parentId NOT IN (SELECT id FROM comments WHERE hidden = 1))';
const COMMENTS_PER_MINUTE = 5;
const POSTS_PER_HOUR = 10;
const MAX_PENDING_POSTS = 20;
const MIN_OFFERS_FOR_RATE = 3;
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
const RESERVED_NICKNAMES = new Set([
  '官方', '管理员', 'admin', 'administrator', '客服', '版主', '小编', '系统',
]);

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

  private author(handle: string): Author {
    const { nickname, avatar } = this.store.get('user', handle)!;
    return { handle, nickname, avatar };
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
        entry = { votes: { up: 0, down: 0, total: 0, upRatio: 0 }, currentUserVote: null, favorited: false, favoriteCount: 0, commentCount: 0 };
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

  private station(record: StationRecord, prefetched?: Map<string, InteractionState>): Station {
    // 传了预取表就一律走表：没有互动的站点不在表里，此时要用「全零」而不是
    // 回退到单条查询——否则「零互动的站点」恰好是最多的那一类，等于没优化。
    const interaction = prefetched
      ? (prefetched.get(record.slug) ?? emptyInteraction())
      : this.interaction({ targetType: 'station', targetId: record.slug });
    const offers = this.offers().filter(offer => offer.stationSlug === record.slug);
    const lowestRate = offers.length ? Math.min(...offers.map(offer => offer.rate)) : null;
    const score = record.uptime === null ? null : Number((record.uptime * 0.6 + (interaction.votes.total ? interaction.votes.upRatio : 0.5) * 30 + (1 / (lowestRate ?? 1)) * 3).toFixed(2));
    return { ...record, ...interaction, lowestRate, score };
  }

  /** 刚入队的站内投稿：先拼出与 Post 一致的结构，审核通过后才从 entities 读。 */
  /** 刚入队的站内投稿，返回与 Post 一致的结构；自动通过时状态就是 approved。 */
  pendingPost(submission: { id: string; payload: unknown; actorHandle: string | null; createdAt: string; status?: string }): Post {
    return this.post(this.queuedPost({
      id: submission.id, payload: submission.payload, status: submission.status ?? 'pending',
      actorHandle: submission.actorHandle ?? this.user, createdAt: submission.createdAt,
    }));
  }

  private post(record: PostRecord, prefetched?: Map<string, InteractionState>): Post {
    const { authorHandle, authorNickname, source, ...fields } = record;
    const author = authorNickname ? { handle: authorHandle, nickname: authorNickname, avatar: '' } : this.author(authorHandle);
    const interaction = prefetched
      ? (prefetched.get(record.id) ?? emptyInteraction())
      : this.interaction({ targetType: 'post', targetId: record.id });
    return { ...fields, author, source: source ?? 'user', ...interaction };
  }

  // 每个站都要用，同一请求内只读一次。
  private cachedOffers?: StationOffer[];
  private offers(): StationOffer[] {
    // 只算在线站点的报价。下架是软删除，报价行仍在库里（恢复时要原样拿回来），
    // 但不能让它们继续参与最低倍率、榜单和模型页的统计。
    return this.cachedOffers ??= this.store.db.prepare(
      "SELECT offer.stationSlug, offer.modelSlug, offer.rate FROM offers AS offer JOIN entities AS station ON station.kind = 'station' AND station.id = offer.stationSlug WHERE station.removedAt IS NULL",
    ).all() as unknown as StationOffer[];
  }

  private hasEnoughOffersForRate(offers: StationOffer[]): boolean {
    return offers.length >= MIN_OFFERS_FOR_RATE;
  }

  /** 公开内容；作者本人的待审和被拒投稿只出现在我的分享和详情页。 */
  private approvedPosts() {
    return this.store.all('post').filter(post => post.status === 'approved');
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
  private myFavorites() {
    const favorites = this.store.db.prepare('SELECT userHandle,targetType,targetId,createdAt FROM favorites WHERE userHandle=? ORDER BY createdAt DESC, rowid DESC').all(this.user) as unknown as Favorite[];
    return favorites.filter(favorite => favorite.targetType === 'post' ? this.readablePost(favorite.targetId) : this.store.get('station', favorite.targetId));
  }

  /** 该账号一共投过多少篇（已物化 + 队列里待审的）。 */
  private countOwnPosts(): number {
    const materialized = Number(this.store.db.prepare(`SELECT count(*) AS count FROM entities WHERE ${POST_AUTHOR}`).get(this.user)!.count);
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
      "SELECT count(*) AS count FROM submissions WHERE kind IN ('post','model') AND channel = 'web' AND actorHandle = ? AND createdAt > ?",
    ).get(this.user, hourAgo)!.count);
  }

  /**
   * 该账号当前待审的站内投稿数（已物化的 pending + 队列里的）。
   * 模型补录也算：它们同样占队列、同样要人审，不数进来就等于开了个无限入口。 */
  private pendingOwnPosts(): number {
    // 同上：pending 只可能出现在队列里，物化后的状态就是 approved。
    return Number(this.store.db.prepare(
      "SELECT count(*) AS count FROM submissions WHERE kind IN ('post','model') AND channel = 'web' AND actorHandle = ? AND status = 'pending'",
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
    } as PostRecord;
  }

  getMe(): CurrentUser {
    const today = shanghaiDate.format(this.now());
    const yesterday = shanghaiDate.format(new Date(this.now().getTime() - dayMs));
    const last = this.store.db.prepare('SELECT date,streak FROM checkins WHERE userHandle=? ORDER BY date DESC LIMIT 1').get(this.user);
    return {
      ...this.store.get('user', this.user)!, checkedInToday: last?.date === today,
      streak: last && (last.date === today || last.date === yesterday) ? Number(last.streak) : 0,
      favoriteCount: this.myFavorites().length,
      shareCount: this.countOwnPosts(),
    };
  }

  updateMe(input: UpdateMeRequest): CurrentUser {
    // 整个「读-查重-写」必须在事务里。两个并发请求（一个改昵称、一个改简介）
    // 各自读到旧 user 再整体展开覆写时，后写的会把先写的改动抹掉；
    // 昵称查重与写入之间也有 TOCTOU：两人可同时通过查重拿到同一个昵称。
    return this.store.transaction(() => {
      const user = this.store.get('user', this.user)!;
      const nickname = input.nickname;
      if (nickname !== undefined) {
        // 列表和详情只渲染 nickname，不渲染 handle，所以「官方」「管理员」这类
        // 展示名一旦能随便取，就等于可以冒充平台身份做钓鱼。
        if (RESERVED_NICKNAMES.has(nickname.trim().toLowerCase())) {
          throw new ApiError(400, 'INVALID_INPUT', `「${nickname}」是保留身份，请换一个昵称`);
        }
        // 与站内其他用户重名同样会让人分不清谁是谁；注册时也走这条。
        const taken = this.store.all('user').find(other => other.handle !== this.user
          && other.nickname.trim().toLowerCase() === nickname.trim().toLowerCase());
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
      const user = this.store.get('user', this.user)!;
      this.store.put('user', this.user, { ...user, tokens: user.tokens + tokensAwarded });
      return { userHandle: this.user, date, tokensAwarded, streak, tokens: user.tokens + tokensAwarded, checkedInToday: true };
    });
  }

  getMyFavorites(query: PaginationQuery) {
    const items = this.myFavorites().map((favorite): FavoriteItem => favorite.targetType === 'post'
      ? { ...favorite, targetType: 'post', post: this.getPost(favorite.targetId) }
      : { ...favorite, targetType: 'station', station: this.station(this.store.get('station', favorite.targetId)!) });
    return paginate(items, query);
  }

  getMyPosts(query: PaginationQuery) {
    const approved = this.store.all('post').filter(p => p.authorHandle === this.user);
    // 加上还在队列里的待审稿：站内发帖已走统一队列，
    // 不列出来作者会以为投稿丢了。
    // 待审与被拒的都列出来：被拒也是作者的记录，他要能看到状态和原因。
    const pending = this.store.db.prepare(
      "SELECT * FROM submissions WHERE kind = 'post' AND channel = 'web' AND actorHandle = ? AND status IN ('pending','rejected')",
    ).all(this.user).map(row => this.queuedPost(row));
    const posts = [...approved, ...pending]
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).map(p => this.post(p));
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
    const offers = this.offers().filter(o => o.modelSlug === slug).sort((a, b) => a.rate - b.rate)
      // 站点已被下架时报价不该出现；用 filter 兜底而不是非空断言，
      // 一条孤儿报价不能把整个模型页变成 500。
      .flatMap(o => { const station = this.store.get('station', o.stationSlug); return station ? [{ ...o, station: this.station(station) }] : []; });
    return { ...model, offers };
  }

  getStations(query: GetStationsRequest) {
    const vendorModels = new Set(this.store.all('model').filter(m => m.vendor === query.vendor).map(m => m.slug));
    const offers = this.offers();
    const vendorStations = new Set(offers.filter(o => vendorModels.has(o.modelSlug)).map(o => o.stationSlug));
    // 这里先留在记录层：score 依赖互动数，排序要用它，所以不能先转 DTO 再排序。
    const records = this.store.all('station').filter(s => (!query.vendor || vendorStations.has(s.slug)) && matches(query.q, s.name, s.slug, s.description));
    const interactions = this.interactionMap('station');
    const items = records.map(s => this.station(s, interactions));
    if (query.sort === 'rate') {
      const offersByStation = new Map<string, StationOffer[]>();
      for (const offer of offers) offersByStation.set(offer.stationSlug, [...(offersByStation.get(offer.stationSlug) ?? []), offer]);
      items.sort((a, b) => {
        const aOffers = offersByStation.get(a.slug) ?? [];
        const bOffers = offersByStation.get(b.slug) ?? [];
        return Number(this.hasEnoughOffersForRate(bOffers)) - Number(this.hasEnoughOffersForRate(aOffers))
          || (a.lowestRate ?? Infinity) - (b.lowestRate ?? Infinity);
      });
    } else {
      items.sort((a, b) => query.sort === 'uptime' ? descendingNullsLast(a.uptime, b.uptime) : descendingNullsLast(a.score, b.score));
    }
    return paginate(items, query);
  }

  getStation(slug: string): StationDetail {
    const station = this.store.get('station', slug);
    if (!station) throw new ApiError(404, 'NOT_FOUND', '中转站不存在');
    return { ...this.station(station), offers: this.offers().filter(o => o.stationSlug === slug).sort((a, b) => a.rate - b.rate)
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

  private hotScoreRecord(post: PostRecord, net: number): number {
    const ageHours = Math.max(0, (this.now().getTime() - Date.parse(post.publishedAt)) / 3600000);
    return net / Math.pow(ageHours + 2, 1.3);
  }

  getPosts(query: GetPostsRequest) {
    const models = new Set(this.store.all('model').filter(m => m.vendor === query.vendor).map(m => m.slug));
    // 排序键（publishedAt、hot 分数）都来自记录本身，不需要组装 DTO，
    // 所以组装推迟到切片之后——否则每次请求都会把全库文章各查一遍互动数据。
    const records = this.approvedPosts().filter(p =>
      (!query.kind || p.kind === query.kind) && (!query.station || p.stationSlug === query.station) &&
      (!query.model || p.modelSlug === query.model) && (!query.vendor || (p.modelSlug !== null && models.has(p.modelSlug))) &&
      matches(query.q, p.title, p.summary, p.body));
    const net = query.sort === 'hot' ? this.netVotes('post') : null;
    records.sort((a, b) => (net
      ? this.hotScoreRecord(b, net.get(b.id) ?? 0) - this.hotScoreRecord(a, net.get(a.id) ?? 0)
      : 0) || b.publishedAt.localeCompare(a.publishedAt));
    const interactions = this.interactionMap('post');
    return paginateThen(records, query, record => this.post(record, interactions));
  }

  getPost(id: string): Post {
    const post = this.readablePost(id);
    if (!post) throw new ApiError(404, 'NOT_FOUND', '文章不存在');
    return this.post(post);
  }

  createPost(input: CreatePostRequest): Post {
    if (input.stationSlug && !this.store.get('station', input.stationSlug)) throw new ApiError(400, 'INVALID_INPUT', '关联中转站不存在');
    if (input.modelSlug && !this.store.get('model', input.modelSlug)) throw new ApiError(400, 'INVALID_INPUT', '关联模型不存在');
    this.assertCanSubmitPost();
    const post: PostRecord = {
      ...input, id: crypto.randomUUID(), authorHandle: this.user, stationSlug: input.stationSlug ?? null,
      modelSlug: input.modelSlug ?? null, cover: null, publishedAt: this.now().toISOString(), status: 'pending',
    };
    this.store.put('post', post.id, post);
    return this.post(post);
  }

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
    const rows = this.store.db.prepare('SELECT id,userHandle,targetType,targetId,content,parentId,createdAt FROM comments WHERE targetType=? AND targetId=? AND hidden = 0 ORDER BY createdAt DESC, rowid DESC').all(query.targetType, query.targetId) as unknown as CommentRow[];
    // 回复按父评论分组，不要对每条顶层评论重扫一遍全部行：
    // 那是 O(顶层数 × 总行数)，一条热帖几百条评论时会明显卡。
    const repliesByParent = new Map<string, CommentRow[]>();
    for (const row of rows) {
      if (row.parentId === null) continue;
      repliesByParent.set(row.parentId, [...(repliesByParent.get(row.parentId) ?? []), row]);
    }
    const tops = rows.filter(row => row.parentId === null);
    // 先切页再组装：回复可能很多，没必要把后面几页的全部装配出来再丢掉。
    return paginateThen(tops, query, row => ({
      ...this.comment(row), parentId: null,
      replies: (repliesByParent.get(row.id) ?? []).reverse().map(reply => ({ ...this.comment(reply), parentId: row.id })),
    }));
  }

  private comment(row: CommentRow) {
    const { userHandle, ...fields } = row;
    return { ...fields, author: this.author(userHandle) };
  }

  createComment(input: CreateCommentRequest): Comment | CommentReply {
    this.requireTarget(input);
    const since = new Date(this.now().getTime() - 60_000).toISOString();
    const recent = Number(this.store.db.prepare('SELECT count(*) AS count FROM comments WHERE userHandle=? AND createdAt > ?').get(this.user, since)!.count);
    if (recent >= COMMENTS_PER_MINUTE) throw new ApiError(429, 'RATE_LIMITED', '评论太频繁了，请稍后再试');
    if (input.parentId) {
      const parent = this.store.db.prepare('SELECT targetType,targetId,parentId FROM comments WHERE id=? AND hidden = 0').get(input.parentId);
      if (!parent || parent.parentId !== null || parent.targetType !== input.targetType || parent.targetId !== input.targetId) throw new ApiError(400, 'INVALID_INPUT', '回复必须属于同一对象的顶层评论');
    }
    const row: CommentRow = { ...input, id: crypto.randomUUID(), userHandle: this.user, parentId: input.parentId ?? null, createdAt: this.now().toISOString() };
    this.store.db.prepare('INSERT INTO comments (id,userHandle,targetType,targetId,content,parentId,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(row.id, row.userHandle, row.targetType, row.targetId, row.content, row.parentId, row.createdAt);
    return row.parentId === null ? { ...this.comment(row), parentId: null, replies: [] } : { ...this.comment(row), parentId: row.parentId };
  }

  getRankings(query: GetRankingsRequest): GetRankingsResponse {
    if (query.tab === 'model') {
      const offers = this.offers();
      const items = this.store.all('model').map(model => {
        const matching = offers.filter(o => o.modelSlug === model.slug);
        return {
          rank: 0, model,
          lowestRate: matching.length ? Math.min(...matching.map(offer => offer.rate)) : null,
          stationCount: matching.length,
          rateEligible: this.hasEnoughOffersForRate(matching),
        };
      });
      // 至少三个站点报价才启用低价加成，避免单条低价决定榜单。
      const score = (item: typeof items[number]) => item.stationCount + (item.rateEligible && item.lowestRate !== null ? 1 / item.lowestRate : 0);
      items.sort((a, b) => Number(b.rateEligible) - Number(a.rateEligible) || score(b) - score(a));
      const ranked = items.slice(0, 12).map(({ rateEligible: _rateEligible, ...item }, index) => ({ ...item, rank: index + 1 }));
      return { tab: 'model', ...paginate(ranked, query) };
    }
    if (query.tab === 'community') {
      const posts = this.approvedPosts().filter(p => p.kind === 'community').map(p => this.post(p));
      posts.sort((a, b) => (b.votes.up * 2 + b.commentCount) - (a.votes.up * 2 + a.commentCount) || b.publishedAt.localeCompare(a.publishedAt));
      return { tab: 'community', ...paginate(posts.slice(0, 12).map((post, index) => ({ rank: index + 1, post })), query) };
    }
    const posts = this.approvedPosts().map(p => this.post(p));
    // 只列有公开文章的人，注册本身不会让账号出现在榜单上。
    const items = this.store.all('user').map(user => {
      const shares = posts.filter(p => p.author.handle === user.handle);
      return { rank: 0, user, shareCount: shares.length, upCount: shares.reduce((sum, p) => sum + p.votes.up, 0) };
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
}
