import { z, ZodError } from 'zod';
import type { CatalogImportRequest, CatalogImportResponse } from '@zhidedeng/shared';
import type { Store } from './database.ts';
import { ApiError } from './errors.ts';

// 群友提交的全量导入。只替换 source=submission 的站点、报价和文章，种子和访客的数据都不动。

const IS_SUBMISSION = "json_extract(data,'$.source') = 'submission'";
const SUBMITTED_STATIONS = `(SELECT id FROM entities WHERE kind = 'station' AND ${IS_SUBMISSION})`;

const singleLine = (max: number) => z.string().min(1).max(max);
const httpUrl = z.string().max(300).refine(value => {
  if (value.includes('?') || value.includes('#')) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
});
const importSchema: z.ZodType<CatalogImportRequest> = z.strictObject({
  stations: z.array(z.strictObject({
    slug: z.string().regex(/^sub-[a-z0-9-]{1,120}$/),
    name: singleLine(60),
    description: singleLine(300),
    url: httpUrl,
    rechargeThreshold: z.number().min(0).nullable(),
    paymentMethods: z.array(singleLine(20)).max(10),
    offers: z.array(z.strictObject({ modelSlug: singleLine(200), rate: z.number().positive() })).max(100),
  })),
  posts: z.array(z.strictObject({
    recordId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    stationSlug: z.string(),
    title: singleLine(100),
    summary: singleLine(200),
    body: singleLine(5000),
    authorName: singleLine(30),
    publishedAt: z.iso.datetime(),
  })),
}).superRefine((input, context) => {
  const slugs = new Set(input.stations.map(station => station.slug));
  const unique = slugs.size === input.stations.length
    && new Set(input.posts.map(post => post.recordId)).size === input.posts.length
    && input.stations.every(station => new Set(station.offers.map(offer => offer.modelSlug)).size === station.offers.length);
  if (!unique) context.addIssue({ code: 'custom', message: '存在重复的站点、记录或报价' });
  if (!input.posts.every(post => slugs.has(post.stationSlug))) context.addIssue({ code: 'custom', message: '文章关联了不存在的站点' });
});

function submissionFingerprint(store: Store) {
  return JSON.stringify([
    store.db.prepare(`SELECT kind, id, data FROM entities WHERE ${IS_SUBMISSION} ORDER BY kind, id`).all(),
    store.db.prepare(`SELECT stationSlug, modelSlug, rate FROM offers WHERE stationSlug IN ${SUBMITTED_STATIONS} ORDER BY stationSlug, modelSlug`).all(),
  ]);
}

function importCatalog(store: Store, input: CatalogImportRequest): CatalogImportResponse {
  return store.transaction(() => {
    const models = new Set(store.all('model').map(model => model.slug));
    const offers = input.stations.flatMap(({ slug, offers }) => offers.map(offer => ({ stationSlug: slug, ...offer })));
    const unknown = offers.find(offer => !models.has(offer.modelSlug));
    if (unknown) throw new ApiError(400, 'INVALID_INPUT', `未知模型：${unknown.modelSlug}`);

    const before = submissionFingerprint(store);
    store.db.prepare(`DELETE FROM offers WHERE stationSlug IN ${SUBMITTED_STATIONS}`).run();
    store.db.prepare(`DELETE FROM entities WHERE ${IS_SUBMISSION}`).run();
    for (const { offers: _offers, ...station } of input.stations) {
      store.put('station', station.slug, { ...station, uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null, source: 'submission' });
    }
    for (const offer of offers) {
      store.db.prepare('INSERT INTO offers (stationSlug, modelSlug, rate) VALUES (?, ?, ?)').run(offer.stationSlug, offer.modelSlug, offer.rate);
    }
    for (const { recordId, authorName, ...post } of input.posts) {
      const id = `feishu-${recordId}`;
      store.put('post', id, { ...post, id, kind: 'review', authorHandle: 'feishu-submission', authorNickname: authorName, modelSlug: null, cover: null, source: 'submission', status: 'approved' });
    }
    return { changed: submissionFingerprint(store) !== before, stations: input.stations.length, offers: offers.length, posts: input.posts.length };
  });
}

const respond = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refuse = (status: number, code: string, message: string) => respond({ error: { code, message } }, status);

export function importResponse(store: Store, rawBody: string) {
  try {
    return respond(importCatalog(store, importSchema.parse(JSON.parse(rawBody))), 200);
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) return refuse(400, 'INVALID_INPUT', '导入内容无效');
    if (error instanceof ApiError) return refuse(error.status, error.code, error.message);
    throw error;
  }
}

/** 管理接口密钥的最短长度，短于它视为未配置。 */
export const MIN_SYNC_TOKEN_LENGTH = 32;

/** 先取摘要再逐字节比较，耗时与 token 内容和长度都无关。 */
async function constantTimeEqual(left: string, right: string) {
  const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  return a.reduce((difference, byte, index) => difference | (byte ^ b[index]), 0) === 0;
}

/** 通过返回 null；否则返回拒绝响应。未配置 SYNC_TOKEN 时一律拒绝。 */
export async function authorizeAdmin(header: string | undefined, token: string | undefined): Promise<Response | null> {
  if (!token) return refuse(403, 'FORBIDDEN', '管理接口未启用');
  const presented = header?.match(/^Bearer (.+)$/)?.[1];
  if (!presented) return refuse(401, 'UNAUTHORIZED', '缺少 Bearer token');
  return await constantTimeEqual(presented, token) ? null : refuse(403, 'FORBIDDEN', 'token 无效');
}
