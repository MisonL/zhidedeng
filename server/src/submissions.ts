import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SubmissionChannel, SubmissionKind, SubmissionRecord, SubmissionStatus } from '@zhidedeng/shared';
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

export function enqueueSubmission(store: Store, input: {
  kind: SubmissionKind;
  channel: SubmissionChannel;
  originKey: string;
  payload: unknown;
  actorHandle?: string | null;
  ip: string;
  now: Date;
}): { submission: SubmissionRecord; deduplicated: boolean } {
  const validated = parse(enqueueSchema, input);
  let payload: string | undefined;
  try {
    payload = JSON.stringify(validated.payload);
  } catch {
    throw new ApiError(400, 'INVALID_INPUT', '投稿内容不是有效 JSON');
  }
  if (payload === undefined) throw new ApiError(400, 'INVALID_INPUT', '投稿内容不是有效 JSON');
  const serialized = payload;
  const payloadHash = createHash('sha256').update(serialized).digest('hex');

  // 查重和插入一起锁定，避免两个来源并发创建相同的待审记录。
  return store.transaction(() => {
    const existing = store.db.prepare("SELECT * FROM submissions WHERE kind = ? AND originKey = ? AND payloadHash = ? AND status = 'pending' ORDER BY createdAt, rowid LIMIT 1")
      .get(validated.kind, validated.originKey, payloadHash);
    if (existing) return { submission: submissionRecord(existing), deduplicated: true };
    const submission: SubmissionRecord = {
      id: randomUUID(), kind: validated.kind, channel: validated.channel, originKey: validated.originKey,
      payload: JSON.parse(serialized), actorHandle: validated.actorHandle ?? null, status: 'pending',
      reason: null, reviewedAt: null, createdAt: validated.now.toISOString(),
    };
    store.db.prepare('INSERT INTO submissions (id, kind, channel, originKey, payload, payloadHash, actorHandle, ip, status, reason, reviewedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(submission.id, submission.kind, submission.channel, submission.originKey, serialized, payloadHash,
        submission.actorHandle, validated.ip, submission.status, submission.reason, submission.reviewedAt, submission.createdAt);
    return { submission, deduplicated: false };
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
 */
function stationSlug(store: Store, url: string | null, originKey: string): string {
  const hostname = hostnameOf(url);
  const identity = hostname ?? originKey.trim().toLowerCase();
  const base = `sub-${identity}`.replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 10);
  const hashed = () => `${base.slice(0, 89)}-${digest}`;
  if (base.length > 100) return hashed();
  const existing = store.get('station', base);
  // 已有站点指向同一个 hostname 说明是在更新它；指向别的 hostname 才是清洗后撞车。
  return existing && hostnameOf(existing.url) !== hostname ? hashed() : base;
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

    if (status === 'approved') {
      if (submission.kind === 'model') {
        const payload = parse(modelSchema, submission.payload);
        if (!store.get('vendor', payload.vendor)) throw new ApiError(400, 'INVALID_INPUT', `厂商 ${payload.vendor} 不存在，请先新增厂商`);
        // 已存在的模型直接覆盖会静默改写名称和厂商、并清空 tags，与新增接口的 409 不一致。
        if (store.get('model', payload.slug)) throw new ApiError(409, 'MODEL_EXISTS', `模型 ${payload.slug} 已存在，如需修改信息请走模型管理接口`);
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

    store.db.prepare('UPDATE submissions SET status = ?, reason = ?, reviewedAt = ? WHERE id = ?').run(status, reason ?? null, reviewedAt, id);
    if (status === 'approved') {
      store.db.prepare("UPDATE submissions SET status = 'superseded', reviewedAt = ? WHERE kind = ? AND originKey = ? AND status = 'pending' AND id <> ?")
        .run(reviewedAt, submission.kind, submission.originKey, id);
    }
    return { ...submission, status, reason: reason ?? null, reviewedAt };
  });
}
