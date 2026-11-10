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

  private station(record: StationRecord): Station {
    const interaction = this.interaction({ targetType: 'station', targetId: record.slug });
    const offers = this.offers().filter(offer => offer.stationSlug === record.slug);
    const lowestRate = offers.length ? Math.min(...offers.map(offer => offer.rate)) : null;
    const score = record.uptime === null ? null : Number((record.uptime * 0.6 + (interaction.votes.total ? interaction.votes.upRatio : 0.5) * 30 + (1 / (lowestRate ?? 1)) * 3).toFixed(2));
    return { ...record, ...interaction, lowestRate, score };
  }

  /** 刚入队的站内投稿：先拼出与 Post 一致的结构，审核通过后才从 entities 读。 */
  pendingPost(submission: { id: string; payload: unknown; actorHandle: string | null; createdAt: string }): Post {
    return this.post(this.queuedPost({
      id: submission.id, payload: submission.payload,
      actorHandle: submission.actorHandle ?? this.user, createdAt: submission.createdAt,
    }));
  }

  private post(record: PostRecord): Post {
    const { authorHandle, authorNickname, source, ...fields } = record;
    const author = authorNickname ? { handle: authorHandle, nickname: authorNickname, avatar: '' } : this.author(authorHandle);
    return { ...fields, author, source: source ?? 'user', ...this.interaction({ targetType: 'post', targetId: record.id }) };
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
    const hourAgo = new Date(this.now().getTime() - 3_600_000).toISOString();
    const materialized = Number(this.store.db.prepare(
      "SELECT count(*) AS count FROM entities WHERE kind = 'post' AND json_extract(data,'$.authorHandle') = ? AND json_extract(data,'$.publishedAt') > ?",
    ).get(this.user, hourAgo)!.count);
    const queued = Number(this.store.db.prepare(
      "SELECT count(*) AS count FROM submissions WHERE kind = 'post' AND actorHandle = ? AND createdAt > ?",
    ).get(this.user, hourAgo)!.count);
    return materialized + queued;
  }

  /** 该账号当前待审的文章数（已物化的 pending + 队列里的）。 */
  private pendingOwnPosts(): number {
    const materialized = Number(this.store.db.prepare(
      "SELECT count(*) AS count FROM entities WHERE kind = 'post' AND json_extract(data,'$.authorHandle') = ? AND json_extract(data,'$.status') = 'pending'",
    ).get(this.user)!.count);
    const queued = Number(this.store.db.prepare(
      "SELECT count(*) AS count FROM submissions WHERE kind = 'post' AND actorHandle = ? AND status = 'pending'",
    ).get(this.user)!.count);
    return materialized + queued;
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
      publishedAt: row.createdAt as string, status: (row.status as string) === 'rejected' ? 'rejected' : 'pending',
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
    const user = this.store.get('user', this.user)!;
    this.store.put('user', this.user, { ...user, ...input });
    return this.getMe();
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
    const items = this.store.all('station').filter(s => (!query.vendor || vendorStations.has(s.slug)) && matches(query.q, s.name, s.slug, s.description)).map(s => this.station(s));
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

  private hotScore(post: Post): number {
    const ageHours = Math.max(0, (this.now().getTime() - Date.parse(post.publishedAt)) / 3600000);
    return (post.votes.up - post.votes.down) / Math.pow(ageHours + 2, 1.3);
  }

  getPosts(query: GetPostsRequest) {
    const models = new Set(this.store.all('model').filter(m => m.vendor === query.vendor).map(m => m.slug));
    const items = this.approvedPosts().filter(p =>
      (!query.kind || p.kind === query.kind) && (!query.station || p.stationSlug === query.station) &&
      (!query.model || p.modelSlug === query.model) && (!query.vendor || (p.modelSlug !== null && models.has(p.modelSlug))) &&
      matches(query.q, p.title, p.summary, p.body)).map(p => this.post(p));
    items.sort((a, b) => (query.sort === 'hot' ? this.hotScore(b) - this.hotScore(a) : 0) || b.publishedAt.localeCompare(a.publishedAt));
    return paginate(items, query);
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
    const items: Comment[] = rows.filter(row => row.parentId === null).map(row => ({
      ...this.comment(row), parentId: null,
      replies: rows.filter(reply => reply.parentId === row.id).reverse().map(reply => ({ ...this.comment(reply), parentId: row.id })),
    }));
    return paginate(items, query);
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
