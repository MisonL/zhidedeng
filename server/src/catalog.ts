import { z, ZodError } from 'zod';
import { MAX_RATE, MIN_RATE } from '@zhidedeng/shared';
import type {
  AdminCreateModelRequest, AdminCreateVendorRequest, AdminDeleteModelResponse, AdminUpdateModelRequest,
  CatalogImportRequest, CatalogImportResponse, Model, Vendor,
} from '@zhidedeng/shared';
import type { Store } from './database.ts';
import { ApiError } from './errors.ts';

// 通用全量导入。替换 source=submission 的集合并处理全部输入 slug，账号和互动保留。

const IS_SUBMISSION = "json_extract(data,'$.source') = 'submission'";
const SUBMITTED_STATIONS = `(SELECT id FROM entities WHERE kind = 'station' AND ${IS_SUBMISSION})`;

const singleLine = (max: number) => z.string().min(1).max(max);
export const offerRate = z.number().refine(rate => rate >= MIN_RATE && rate <= MAX_RATE, {
  error: issue => ({ message: `倍率 ${String(issue.input)} 超出 ${MIN_RATE}~${MAX_RATE} 范围` }),
});
export const httpUrl = z.string().max(300).refine(value => {
  if (value.includes('?') || value.includes('#')) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
});
const importSchema: z.ZodType<CatalogImportRequest> = z.strictObject({
  allowNewModels: z.boolean().optional(),
  stations: z.array(z.strictObject({
    slug: z.string().regex(/^sub-[a-z0-9-]{1,120}$/),
    name: singleLine(60),
    description: singleLine(300),
    url: httpUrl,
    rechargeThreshold: z.number().min(0).nullable(),
    paymentMethods: z.array(singleLine(20)).max(10),
    offers: z.array(z.strictObject({ modelSlug: singleLine(200), rate: offerRate })).max(100),
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
    const stations = input.stations.filter(station => {
      const existing = store.get('station', station.slug);
      if (existing && existing.source !== 'submission' && existing.source !== 'demo') {
        console.warn(`跳过导入站点 ${station.slug}：已有来源 ${existing.source}`);
        return false;
      }
      return true;
    });
    const offers = stations.flatMap(({ slug, offers: stationOffers }) => stationOffers.map(offer => ({ stationSlug: slug, ...offer })));

    const models = new Set(store.all('model').map(model => model.slug));
    const unknown = [...new Set(offers.map(offer => offer.modelSlug).filter(slug => !models.has(slug)))];
    if (unknown.length && !input.allowNewModels) throw new ApiError(400, 'INVALID_INPUT', `未知模型：${unknown[0]}`);

    const before = submissionFingerprint(store);
    // 自动创建的占位模型统一挂在 unknown 厂商下，等管理员补全或改建正式厂商。
    // slug 与直接新增用同一套规则校验，否则像 foo/bar 这种会成为 /models/:slug 无法路由的孤儿。
    if (unknown.length) {
      const resolved: string[] = [];
      for (const slug of unknown) {
        const parsed = adminSlug.safeParse(slug);
        // 用解析后的值（已 trim），否则 ' x ' 会带着空格入库，两条 URL 都路由不到。
        if (!parsed.success) throw new ApiError(400, 'INVALID_INPUT', `未知模型 ${slug} 不符合 slug 规则，无法自动收录，请先在模型管理接口补录`);
        resolved.push(parsed.data);
      }
      if (!store.get('vendor', 'unknown')) store.put('vendor', 'unknown', { slug: 'unknown', name: '未知厂商', iconKey: 'unknown' });
      for (const slug of resolved) {
        store.put('model', slug, { slug, vendor: 'unknown', name: slug, description: '群友/Agent 提交时自动创建，待补全', tags: [] });
      }
    }
    store.db.prepare(`DELETE FROM offers WHERE stationSlug IN ${SUBMITTED_STATIONS}`).run();
    store.db.prepare(`DELETE FROM entities WHERE ${IS_SUBMISSION}`).run();
    for (const { offers: _offers, ...station } of stations) {
      // 允许导入的 slug 要先替换原报价，避免残留或撞唯一约束。
      store.db.prepare('DELETE FROM offers WHERE stationSlug = ?').run(station.slug);
      // 指标字段导入内容里没有，沿用旧值：写 null 会把可用率永久清零。
      const previous = store.get('station', station.slug);
      store.put('station', station.slug, {
        ...station, status: previous?.status ?? null, uptime: previous?.uptime ?? null,
        firstTokenLatencyMs: previous?.firstTokenLatencyMs ?? null, foundedAt: previous?.foundedAt ?? null,
        source: 'submission',
      });
    }
    for (const offer of offers) {
      store.db.prepare('INSERT INTO offers (stationSlug, modelSlug, rate) VALUES (?, ?, ?)').run(offer.stationSlug, offer.modelSlug, offer.rate);
    }
    for (const { recordId, authorName, ...post } of input.posts) {
      const id = `feishu-${recordId}`;
      store.put('post', id, { ...post, id, kind: 'review', authorHandle: 'feishu-submission', authorNickname: authorName, modelSlug: null, cover: null, source: 'submission', status: 'approved' });
    }
    return { changed: unknown.length > 0 || submissionFingerprint(store) !== before, stations: stations.length, offers: offers.length, posts: input.posts.length, createdModels: unknown.sort() };
  });
}

const respond = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refuse = (status: number, code: string, message: string) => respond({ error: { code, message } }, status);

export function importResponse(store: Store, rawBody: string) {
  try {
    return respond(importCatalog(store, importSchema.parse(JSON.parse(rawBody))), 200);
  } catch (error) {
    if (error instanceof ZodError) {
      const rateIssue = error.issues.find(issue => issue.code === 'custom' && issue.message.startsWith('倍率 '));
      return refuse(400, 'INVALID_INPUT', rateIssue?.message ?? '导入内容无效');
    }
    if (error instanceof SyntaxError) return refuse(400, 'INVALID_INPUT', '导入内容无效');
    if (error instanceof ApiError) return refuse(error.status, error.code, error.message);
    throw error;
  }
}

/** 管理接口密钥的最短长度，短于它视为未配置。 */
export const MIN_SYNC_TOKEN_LENGTH = 32;

// 模型和厂商的 slug 共用同一套规则：小写字母、数字和连字符，最长 64。
const slugPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const adminSlug = z.string().trim().regex(slugPattern);

export function createVendor(store: Store, input: AdminCreateVendorRequest): Vendor {
  return store.transaction(() => {
    if (store.get('vendor', input.slug)) throw new ApiError(409, 'VENDOR_EXISTS', `厂商已存在：${input.slug}`);
    const vendor: Vendor = { slug: input.slug, name: input.name, iconKey: input.iconKey ?? input.slug };
    store.put('vendor', vendor.slug, vendor);
    return vendor;
  });
}

export function createModel(store: Store, input: AdminCreateModelRequest): Model {
  return store.transaction(() => {
    if (store.get('model', input.slug)) throw new ApiError(409, 'MODEL_EXISTS', `模型已存在：${input.slug}`);
    if (!store.get('vendor', input.vendor)) throw new ApiError(400, 'INVALID_INPUT', `厂商不存在：${input.vendor}`);
    const model: Model = { slug: input.slug, vendor: input.vendor, name: input.name, description: input.description, tags: [] };
    store.put('model', model.slug, model);
    return model;
  });
}

/** 修改已收录模型的可编辑字段。slug 是主键，改不了；被引用也不影响改名字和厂商。 */
export function updateModel(store: Store, slug: string, input: AdminUpdateModelRequest): Model {
  return store.transaction(() => {
    const model = store.get('model', slug);
    if (!model) throw new ApiError(404, 'NOT_FOUND', `模型不存在：${slug}`);
    if (!store.get('vendor', input.vendor)) throw new ApiError(400, 'INVALID_INPUT', `厂商不存在：${input.vendor}`);
    // tags 不在这个接口的可编辑范围，保持原值，避免顺手清空。
    const updated: Model = { ...model, vendor: input.vendor, name: input.name, description: input.description };
    store.put('model', slug, updated);
    return updated;
  });
}

export function deleteModel(store: Store, slug: string): AdminDeleteModelResponse {
  return store.transaction(() => {
    if (!store.get('model', slug)) throw new ApiError(404, 'NOT_FOUND', `模型不存在：${slug}`);
    const offers = store.db.prepare('SELECT COUNT(DISTINCT stationSlug) AS count FROM offers WHERE modelSlug = ?').get(slug)!;
    const stationCount = Number(offers.count);
    // 文章也会关联模型，直接删会留下指向不存在模型的引用。
    const posts = store.db.prepare("SELECT COUNT(*) AS count FROM entities WHERE kind = 'post' AND json_extract(data,'$.modelSlug') = ?").get(slug)!;
    const postCount = Number(posts.count);
    if (stationCount + postCount > 0) {
      const used = [stationCount && `${stationCount} 个站点的报价`, postCount && `${postCount} 篇文章`].filter(Boolean).join('和');
      throw new ApiError(409, 'MODEL_IN_USE', `模型仍被${used}引用`, { stationCount, postCount });
    }
    store.db.prepare('DELETE FROM entities WHERE kind = ? AND id = ?').run('model', slug);
    return { slug, deleted: true };
  });
}

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
