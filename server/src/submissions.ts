import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SubmissionChannel, SubmissionKind, SubmissionRecord, SubmissionStatus } from '@zhidedeng/shared';
import { STATION_SLUG_MAX, stationSlugBase, stationSlugSuffix } from '@zhidedeng/shared';
import { adminSlug, httpUrl, offerRate } from './catalog.ts';
import type { SqlRow, SqlValue, Store } from './database.ts';
import { ApiError } from './errors.ts';

const submissionKind = z.enum(['station', 'model', 'post']);
const submissionStatus = z.enum(['pending', 'approved', 'rejected', 'superseded']);
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, '内容不能为空');
const sourceByChannel = { agent: 'agent', feishu: 'submission', web: 'user' } as const;

export const submissionQuerySchema = z.strictObject({
  status: submissionStatus.optional(),
  kind: submissionKind.optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).transform(size => Math.min(size, 50)).default(20),
});
export const submissionReviewSchema = z.strictObject({
  status: z.enum(['approved', 'rejected']),
  reason: z.string().trim().max(1000).optional(),
});

const enqueueSchema = z.object({
  kind: submissionKind,
  channel: z.enum(['feishu', 'agent', 'web']),
  originKey: z.string().min(1).max(253),
  payload: z.unknown(),
  actorHandle: text(200).nullish(),
  ip: z.string().min(1).max(100),
  now: z.date(),
});
const modelSchema = z.object({ slug: adminSlug, vendor: adminSlug, name: text(60), description: text(200) });
const stationSchema = z.object({
  name: text(60),
  description: text(300),
  url: httpUrl,
  rechargeThreshold: z.number().min(0).nullable(),
  paymentMethods: z.array(text(20)).max(10),
  offers: z.array(z.object({ modelSlug: text(200), rate: offerRate })).max(100),
}).refine(station => new Set(station.offers.map(offer => offer.modelSlug)).size === station.offers.length, '存在重复的报价');
const postSchema = z.object({
  title: text(100), summary: text(200), body: text(5000), authorName: text(30),
  authorHandle: text(200).nullish(), hostname: text(253).nullish(), publishedAt: z.iso.datetime().nullish(),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ApiError(400, 'INVALID_INPUT', `投稿参数无效：${issue.path.join('.')}: ${issue.message}`);
  }
  return result.data;
}

function submissionRecord(row: SqlRow): SubmissionRecord {
  return {
    id: row.id as string, kind: row.kind as SubmissionKind, channel: row.channel as SubmissionChannel,
    originKey: row.originKey as string, payload: JSON.parse(row.payload as string),
    actorHandle: row.actorHandle as string | null, status: row.status as SubmissionStatus,
    reason: row.reason as string | null, createdAt: row.createdAt as string, reviewedAt: row.reviewedAt as string | null,
  };
}

const AUTO_APPROVE_KEY = 'submissions.autoApprove';

/** 自动通过开关。管理员可随时切换，默认关闭（所有投稿都要人工审）。 */
export function autoApproveEnabled(store: Store): boolean {
  return store.db.prepare('SELECT value FROM settings WHERE key = ?').get(AUTO_APPROVE_KEY)?.value === 'true';
}

export function setAutoApprove(store: Store, enabled: boolean, now: Date): boolean {
  store.db.prepare('INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt')
    .run(AUTO_APPROVE_KEY, String(enabled), now.toISOString());
  return enabled;
}

/**
 * 入队。开启自动通过时在同一请求里直接物化，返回 approved 的记录；
 * 校验不通过则不入队也不上站，直接 400，不会留下需要清理的脏记录。
 */
export function enqueueSubmission(store: Store, input: {
  kind: SubmissionKind;
  channel: SubmissionChannel;
  originKey: string;
  payload: unknown;
  actorHandle?: string | null;
  ip: string;
  now: Date;
}): { submission: SubmissionRecord; deduplicated: boolean; autoApproved: boolean } {
  const validated = parse(enqueueSchema, input);
  // 自动通过时先校验 payload 格式，避免把一条注定审核失败的记录写进队列。
  if (autoApproveEnabled(store)) validatePayload(validated.kind, validated.payload);
  let payload: string | undefined;
  try {
    payload = JSON.stringify(validated.payload);
  } catch {
    throw new ApiError(400, 'INVALID_INPUT', '投稿内容不是有效 JSON');
  }
  if (payload === undefined) throw new ApiError(400, 'INVALID_INPUT', '投稿内容不是有效 JSON');
  const serialized = payload;
  const payloadHash = createHash('sha256').update(serialized).digest('hex');

  // 查重、插入和（可选）自动物化一起锁定，避免并发下重复入队或半途失败留下脏记录。
  const auto = autoApproveEnabled(store);
  return store.transaction(() => {
    // 自动通过下相同内容已上站就不再重复物化；人工审核下仍只按 pending 去重。
    const scope = auto ? "AND status IN ('pending','approved')" : "AND status = 'pending'";
    const existing = store.db.prepare(`SELECT * FROM submissions WHERE kind = ? AND originKey = ? AND payloadHash = ? ${scope} ORDER BY createdAt, rowid LIMIT 1`)
      .get(validated.kind, validated.originKey, payloadHash);
    if (existing) return { submission: submissionRecord(existing), deduplicated: true, autoApproved: false };
    const reviewedAt = validated.now.toISOString();
    const submission: SubmissionRecord = {
      id: randomUUID(), kind: validated.kind, channel: validated.channel, originKey: validated.originKey,
      payload: JSON.parse(serialized), actorHandle: validated.actorHandle ?? null,
      status: auto ? 'approved' : 'pending', reason: auto ? '自动通过' : null,
      reviewedAt: auto ? reviewedAt : null, createdAt: reviewedAt,
    };
    // 物化失败时整条记录随事务回滚，不会留下 approved 但没上站的幽灵。
    if (auto) materialize(store, submission, reviewedAt);
    store.db.prepare('INSERT INTO submissions (id, kind, channel, originKey, payload, payloadHash, actorHandle, ip, status, reason, reviewedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(submission.id, submission.kind, submission.channel, submission.originKey, serialized, payloadHash,
        submission.actorHandle, validated.ip, submission.status, submission.reason, submission.reviewedAt, submission.createdAt);
    if (auto) supersedePending(store, submission, reviewedAt);
    return { submission, deduplicated: false, autoApproved: auto };
  });
}

export function listSubmissions(store: Store, input: {
  status?: SubmissionStatus;
  kind?: SubmissionKind;
  page?: number;
  pageSize?: number;
}) {
  const { status, kind, page, pageSize } = parse(submissionQuerySchema, input);
  const filters: string[] = [];
  const params: SqlValue[] = [];
  if (status) { filters.push('status = ?'); params.push(status); }
  if (kind) { filters.push('kind = ?'); params.push(kind); }
  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const total = Number(store.db.prepare(`SELECT COUNT(*) AS total FROM submissions${where}`).get(...params)!.total);
  const rows = store.db.prepare(`SELECT * FROM submissions${where} ORDER BY createdAt, rowid LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  return { items: rows.map(submissionRecord), total, page, pageSize };
}

/** 从站点 url 取归一化 hostname，用于判断某个 slug 是不是同一个站点。 */
function hostnameOf(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/**
 * 站点 slug：`sub-` 加归一化 hostname 的可读形式。
 * hostname 超过长度上限、或清洗后与另一个站点撞车时，改用哈希后缀保证唯一——
 * 否则两个不同站点会写到同一条记录上，后审的覆盖先审的。
 * 身份一律取 url 的 hostname（不是 originKey），这样飞书用记录 ID 做 originKey 时，
 * 同一站点的重复提交仍然落在同一条记录上。
 * 派生规则来自 shared/slug.ts，飞书同步脚本用的是同一份，两边算出的 slug 必须一致。
 */
function stationSlug(store: Store, url: string | null, originKey: string): string {
  const hostname = hostnameOf(url);
  const identity = hostname ?? originKey.trim().toLowerCase();
  // 先认领：只要已有站点的 hostname 相同，就沿用它的 slug——不管当初落在可读形式
  // 还是哈希后缀上。否则 base 被别的站占走又释放时，同一站点会在两种 slug 间横跳。
  const mine = hostname === null ? undefined : store.all('station').find(station => hostnameOf(station.url) === hostname);
  if (mine) return mine.slug;

  const base = stationSlugBase(identity);
  if (base.length <= STATION_SLUG_MAX && !store.get('station', base)) return base;
  // 撞车或超长：可读前缀加哈希。哈希本身也可能撞上别的站点（例如某个 hostname
  // 恰好等于 "<别的域名>-<这几位>"），所以继续加盐直到找到空位。
  for (let salt = 0; salt < 100; salt += 1) {
    const suffix = stationSlugSuffix(identity, salt);
    const candidate = `${base.slice(0, STATION_SLUG_MAX - suffix.length - 1)}-${suffix}`;
    if (!store.get('station', candidate)) return candidate;
  }
  throw new ApiError(409, 'SLUG_CONFLICT', '无法为这个站点分配唯一的地址');
}

/** 只校验 payload 的形状，不写入。自动通过时先跑一遍，避免把注定失败的记录塞进队列。 */
function validatePayload(kind: SubmissionKind, payload: unknown): void {
  if (kind === 'model') parse(modelSchema, payload);
  else if (kind === 'station') parse(stationSchema, payload);
  else parse(postSchema, payload);
}

/** 把一条投稿写进 entities。不自己开事务，由调用方决定边界。 */
function materialize(store: Store, submission: SubmissionRecord, reviewedAt: string): void {
  if (submission.kind === 'model') {
    const payload = parse(modelSchema, submission.payload);
    if (!store.get('vendor', payload.vendor)) throw new ApiError(400, 'INVALID_INPUT', `厂商 ${payload.vendor} 不存在，请先新增厂商`);
    // 已存在的模型直接覆盖会静默改写名称和厂商、并清空 tags，与新增接口的 409 不一致。
    if (store.get('model', payload.slug)) throw new ApiError(409, 'MODEL_EXISTS', `模型 ${payload.slug} 已存在，请拒绝这条投稿；如需改名请用 PATCH /api/admin/models/:slug`);
    store.put('model', payload.slug, { ...payload, tags: [] });
  } else if (submission.kind === 'station') {
    const { offers, ...payload } = parse(stationSchema, submission.payload);
    for (const offer of offers) {
      if (!store.get('model', offer.modelSlug)) throw new ApiError(400, 'INVALID_INPUT', `未知模型：${offer.modelSlug}`);
    }
    const slug = stationSlug(store, payload.url, submission.originKey);
    const previous = store.get('station', slug);
    // 更新已有 slug 时保留最初来源，不能把飞书站点改标成 AI 采集。
    store.put('station', slug, {
      ...payload, slug, uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null,
      source: previous ? previous.source : sourceByChannel[submission.channel],
    });
    store.db.prepare('DELETE FROM offers WHERE stationSlug = ?').run(slug);
    const insert = store.db.prepare('INSERT INTO offers (stationSlug, modelSlug, rate) VALUES (?, ?, ?)');
    for (const offer of offers) insert.run(slug, offer.modelSlug, offer.rate);
  } else {
    const payload = parse(postSchema, submission.payload);
    const hostname = payload.hostname?.toLowerCase();
    const stationSlug = hostname
      ? store.all('station').find(station => station.url !== null && new URL(station.url).hostname === hostname)?.slug ?? null
      : null;
    const postId = `sub-${submission.id}`;
    store.put('post', postId, {
      id: postId, kind: 'review', title: payload.title, summary: payload.summary, body: payload.body,
      authorHandle: payload.authorHandle ?? 'anonymous-submission', authorNickname: payload.authorName,
      stationSlug, modelSlug: null, cover: null, publishedAt: payload.publishedAt ?? reviewedAt,
      status: 'approved', source: sourceByChannel[submission.channel],
    });
  }
}

/** 新版本上站后，同来源同 key 的其他待审记录没有再审的意义。 */
function supersedePending(store: Store, submission: SubmissionRecord, reviewedAt: string): void {
  store.db.prepare("UPDATE submissions SET status = 'superseded', reviewedAt = ? WHERE kind = ? AND originKey = ? AND status = 'pending' AND id <> ?")
    .run(reviewedAt, submission.kind, submission.originKey, submission.id);
}

export function reviewSubmission(store: Store, now: Date, id: string, decision: {
  status: 'approved' | 'rejected';
  reason?: string;
}): SubmissionRecord {
  const { status, reason } = parse(submissionReviewSchema, decision);
  const reviewedAt = parse(z.date(), now).toISOString();
  return store.transaction(() => {
    const row = store.db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', '投稿不存在');
    const submission = submissionRecord(row);
    if (submission.status !== 'pending') throw new ApiError(409, 'ALREADY_REVIEWED', '投稿已审核或被新版本替代');

    if (status === 'approved') materialize(store, submission, reviewedAt);

    store.db.prepare('UPDATE submissions SET status = ?, reason = ?, reviewedAt = ? WHERE id = ?').run(status, reason ?? null, reviewedAt, id);
    if (status === 'approved') supersedePending(store, submission, reviewedAt);
    return { ...submission, status, reason: reason ?? null, reviewedAt };
  });
}
