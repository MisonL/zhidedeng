import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AdminBatchSubmitRequest, AdminBatchSubmitResponse, AdminSubmissionStateResponse, SubmissionChannel, SubmissionKind, SubmissionRecord, SubmissionStatus } from '@zhidedeng/shared';
import { feishuHostnameKey, STATION_SLUG_MAX, stationSlugBase, stationSlugSuffix } from '@zhidedeng/shared';
import { adminSlug, httpUrl, postSchema, stationSchema, text } from '@zhidedeng/shared/submission';

import type { SqlRow, SqlValue, StationRecord, Store } from './database.ts';
import { ApiError } from './errors.ts';

const submissionKind = z.enum(['station', 'model', 'post']);
const submissionChannel = z.enum(['feishu', 'agent', 'web']);
const submissionAction = z.enum(['upsert', 'remove']);
const submissionStatus = z.enum(['pending', 'approved', 'rejected', 'superseded']);
const sourceByChannel = { agent: 'agent', feishu: 'submission', web: 'user' } as const;
const batchIdentifier = z.string().trim().min(1).max(200);

export const submissionQuerySchema = z.strictObject({
  status: submissionStatus.optional(),
  kind: submissionKind.optional(),
  batchId: batchIdentifier.optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).transform(size => Math.min(size, 50)).default(20),
});
export const submissionReviewSchema = z.strictObject({
  status: z.enum(['approved', 'rejected']),
  reason: z.string().trim().max(1000).optional(),
});
export const submissionBatchReviewSchema = z.union([
  submissionReviewSchema.extend({ ids: z.array(z.string().trim().min(1).max(200)).min(1).max(100) }),
  submissionReviewSchema.extend({ batchId: batchIdentifier }),
]);

const submissionFields = {
  kind: submissionKind,
  originKey: z.string().min(1).max(253),
  payload: z.unknown(),
  actorHandle: text(200).nullish(),
  action: submissionAction.default('upsert'),
};
export const submissionBatchSchema = z.strictObject({
  channel: submissionChannel,
  batchId: batchIdentifier.optional(),
  items: z.array(z.object(submissionFields)).max(500),
});
const enqueueSchema = z.object({
  ...submissionFields,
  channel: submissionChannel,
  batchId: batchIdentifier.nullish(),
  ip: z.string().min(1).max(100),
  now: z.date(),
}).refine(input => input.action !== 'remove' || input.kind === 'station', '只有站点支持下架');
export { postSchema, stationSchema };
const modelSchema = z.object({ slug: adminSlug, vendor: adminSlug, name: text(60), description: text(200) });
const stationUrlSchema = z.object({ url: httpUrl });
const removalSchema = z.object({ slug: z.string().min(1).max(200), submissionId: batchIdentifier });

export function parseSubmissionInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.code === 'unrecognized_keys' ? [...issue.path, ...issue.keys].join('.') : issue.path.join('.');
    throw new ApiError(400, 'INVALID_INPUT', `投稿参数无效：${field}: ${issue.message}`);
  }
  return result.data;
}

const parse = parseSubmissionInput;

function submissionRecord(row: SqlRow): SubmissionRecord {
  return {
    id: row.id as string, kind: row.kind as SubmissionKind, channel: row.channel as SubmissionChannel,
    originKey: row.originKey as string, payload: JSON.parse(row.payload as string),
    batchId: row.batchId as string | null, action: row.action as SubmissionRecord['action'],
    actorHandle: row.actorHandle as string | null, status: row.status as SubmissionStatus,
    reason: row.reason as string | null, createdAt: row.createdAt as string, reviewedAt: row.reviewedAt as string | null,
  };
}

/** 站点身份由实际网址决定；下架按 slug 查目标，不信任客户端给的 key。 */
function submissionOriginKey(store: Store, input: {
  kind: SubmissionKind; action: SubmissionRecord['action']; payload: unknown; originKey: string;
}): string {
  if (input.kind !== 'station') return input.originKey;
  if (input.action === 'remove') {
    const { slug } = parse(removalSchema, input.payload);
    const station = store.get('station', slug);
    // 不存在的目标只用规范化的客户端 hostname 检查冲突，审核时按幂等下架处理。
    const url = station ? parse(httpUrl, station.url) : parse(httpUrl, `https://${input.originKey}`);
    return new URL(url).hostname;
  }
  return new URL(parse(stationUrlSchema, input.payload).url).hostname;
}

function assertBatchChannel(store: Store, batchId: string | null | undefined, channel: SubmissionChannel): void {
  if (batchId === null || batchId === undefined) return;
  const conflict = store.db.prepare('SELECT channel FROM submissions WHERE batchId = ? AND channel <> ? LIMIT 1').get(batchId, channel);
  if (conflict) throw new ApiError(409, 'BATCH_CHANNEL_MISMATCH', `批次 ${batchId} 属于 ${String(conflict.channel)} 渠道，不能混入 ${channel} 投稿`);
}

function assertBatchOpen(store: Store, batchId: string | null | undefined): void {
  if (batchId === null || batchId === undefined) return;
  // 还有待审条目，说明这一批还没审完，继续追加是正常的重试/续块。
  if (store.db.prepare("SELECT 1 FROM submissions WHERE batchId = ? AND status = 'pending' LIMIT 1").get(batchId)) return;
  // 自动通过的分块会把每条立即置为 approved，此时批次其实还在进行中；
  // 若把它们当成「已审核」，开启自动通过后超过一块的同步就必然失败。
  const reviewed = store.db.prepare("SELECT 1 FROM submissions WHERE batchId = ? AND NOT (status = 'approved' AND autoApproved = 1) LIMIT 1")
    .get(batchId);
  if (reviewed) throw new ApiError(409, 'BATCH_ALREADY_REVIEWED', '批次已审核完成，不能追加新条目');
}

const AUTO_APPROVE_KEY = 'submissions.autoApprove';
/** 给管理员展示的审核原因；批次状态由 autoApproved 元数据判断。 */
const AUTO_APPROVE_REASON = '自动通过';

/** 自动通过开关。管理员可随时切换，默认关闭（所有投稿都要人工审）。 */
export function autoApproveEnabled(store: Store): boolean {
  return store.db.prepare('SELECT value FROM settings WHERE key = ?').get(AUTO_APPROVE_KEY)?.value === 'true';
}

export function setAutoApprove(store: Store, enabled: boolean, now: Date): boolean {
  return store.transaction(() => {
    store.db.prepare('INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt')
      .run(AUTO_APPROVE_KEY, String(enabled), now.toISOString());
    return enabled;
  });
}

/**
 * 入队。开启自动通过时只直接物化 upsert，下架始终等待人工审核；
 * 校验不通过则不入队也不上站，直接 400，不会留下需要清理的脏记录。
 */
export function enqueueSubmission(store: Store, input: {
  kind: SubmissionKind;
  channel: SubmissionChannel;
  originKey: string;
  batchId?: string | null;
  action?: SubmissionRecord['action'];
  payload: unknown;
  actorHandle?: string | null;
  ip: string;
  now: Date;
}, options: {
  pendingOnly?: boolean;
  deduplicateByActor?: boolean;
  // 在查重之后、插入之前执行，复用本函数的 BEGIN IMMEDIATE，不能另开事务。
  beforeInsert?: () => void;
  /**
   * 命中幂等去重时的回调。调用方可以退掉常规额度、改记到单独的宽松配额上：
   * 重试不该扣光额度，无限探测又必须被限住。
   */
  onDeduplicated?: () => void;
} = {}): { submission: SubmissionRecord; deduplicated: boolean; autoApproved: boolean } {
  const validated = parse(enqueueSchema, input);
  let payload: string | undefined;
  try {
    payload = JSON.stringify(validated.payload);
  } catch {
    throw new ApiError(400, 'INVALID_INPUT', '投稿内容不是有效 JSON');
  }
  if (payload === undefined) throw new ApiError(400, 'INVALID_INPUT', '投稿内容不是有效 JSON');
  const serialized = payload;
  const parsedPayload: unknown = JSON.parse(serialized);
  const payloadHash = createHash('sha256').update(serialized).digest('hex');

  // 查重、插入和（可选）自动物化一起锁定，避免并发下重复入队或半途失败留下脏记录。
  return store.transaction(() => {
    assertBatchChannel(store, validated.batchId, validated.channel);
    assertBatchOpen(store, validated.batchId);
    const originKey = submissionOriginKey(store, { ...validated, payload: parsedPayload });
    const auto = !options.pendingOnly && autoApproveEnabled(store) && validated.action === 'upsert';
    if (auto || validated.action === 'remove') validatePayload(store, validated.kind, parsedPayload, validated.action);
    // 自动通过下相同内容已上站就不再重复物化；人工审核下仍只按 pending 去重。
    // 幂等限定在同一批次内，避免新批次借用旧批次的 id，导致一键审核漏掉这些条目。
    const scope = auto ? "AND status IN ('pending','approved')" : "AND status = 'pending'";
    const actorScope = options.deduplicateByActor ? 'AND channel = ? AND actorHandle IS ?' : '';
    const existing = store.db.prepare(`SELECT * FROM submissions WHERE kind = ? AND originKey = ? AND action = ? AND payloadHash = ? AND batchId IS ? ${actorScope} ${scope} ORDER BY createdAt DESC, rowid DESC LIMIT 1`)
      .get(validated.kind, originKey, validated.action, payloadHash, validated.batchId ?? null,
        ...(options.deduplicateByActor ? [validated.channel, validated.actorHandle ?? null] : []));
    const reviewedAt = validated.now.toISOString();
    // 飞书 www/裸域切换会更新同一实体，版本应取实际实体当前 URL 的 hostname。
    const currentOriginKey = auto && existing?.status === 'approved' && validated.kind === 'station'
      ? hostnameOf(findStation(store, submissionRecord(existing), parse(stationUrlSchema, parsedPayload).url)?.url ?? null)
      : originKey;
    const latest = auto && existing?.status === 'approved' && currentOriginKey !== null
      ? store.db.prepare("SELECT id FROM submissions WHERE kind = ? AND originKey = ? AND status = 'approved' ORDER BY reviewedAt DESC, rowid DESC LIMIT 1").get(validated.kind, currentOriginKey)
      : undefined;
    // approved 只在仍是最新版本时去重，否则需要重新物化本次提交的内容。
    if (existing && (existing.status === 'pending' || latest?.id === existing.id)) {
      const submission = submissionRecord(existing);
      if (auto && submission.status === 'pending') {
        materialize(store, submission, reviewedAt);
        store.db.prepare("UPDATE submissions SET status = 'approved', autoApproved = 1, reason = ?, reviewedAt = ? WHERE id = ?").run(AUTO_APPROVE_REASON, reviewedAt, submission.id);
        supersedePending(store, submission, reviewedAt);
        return { submission: { ...submission, status: 'approved', reason: AUTO_APPROVE_REASON, reviewedAt }, deduplicated: true, autoApproved: true };
      }
      options.onDeduplicated?.();
      return { submission, deduplicated: true, autoApproved: false };
    }
    options.beforeInsert?.();
    const submission: SubmissionRecord = {
      id: randomUUID(), kind: validated.kind, channel: validated.channel, originKey,
      batchId: validated.batchId ?? null, action: validated.action,
      payload: parsedPayload, actorHandle: validated.actorHandle ?? null,
      status: auto ? 'approved' : 'pending', reason: auto ? AUTO_APPROVE_REASON : null,
      reviewedAt: auto ? reviewedAt : null, createdAt: reviewedAt,
    };
    // 物化失败时整条记录随事务回滚，不会留下 approved 但没上站的幽灵。
    if (auto) materialize(store, submission, reviewedAt);
    store.db.prepare('INSERT INTO submissions (id, kind, channel, originKey, batchId, action, autoApproved, payload, payloadHash, actorHandle, ip, status, reason, reviewedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(submission.id, submission.kind, submission.channel, submission.originKey, submission.batchId, submission.action, auto ? 1 : 0, serialized, payloadHash,
        submission.actorHandle, validated.ip, submission.status, submission.reason, submission.reviewedAt, submission.createdAt);
    if (auto) supersedePending(store, submission, reviewedAt);
    return { submission, deduplicated: false, autoApproved: auto };
  });
}

/** 先拒绝批次身份冲突和无版本下架；其余业务校验逐条返回，各自提交事务。 */
export function enqueueBatch(store: Store, input: AdminBatchSubmitRequest & { ip: string; now: Date }): AdminBatchSubmitResponse {
  const batch = parse(submissionBatchSchema, { channel: input.channel, batchId: input.batchId, items: input.items });
  const batchId = batch.batchId ?? randomUUID();
  if (batch.items.length > 0) {
    assertBatchChannel(store, batchId, batch.channel);
    assertBatchOpen(store, batchId);
  }
  const stationOrigins = new Map<string, { index: number; action: SubmissionRecord['action']; slug?: string; removable: boolean }[]>();
  for (const [index, item] of batch.items.entries()) {
    if (item.kind !== 'station') continue;
    const hostname = submissionOriginKey(store, item);
    // 飞书会把 www 与裸域名物化到同一站点，冲突检测必须沿用这个分组。
    const key = batch.channel === 'feishu' ? feishuHostnameKey(hostname) : hostname;
    const action = item.action ?? 'upsert';
    const removal = action === 'remove' ? parse(removalSchema, item.payload) : undefined;
    const slug = removal?.slug;
    const target = slug ? store.get('station', slug) : undefined;
    // 重试时部分实体可能已经下架；只沿用属于该 hostname 的真实 approved 版本。
    const version = removal && !target
      ? store.db.prepare("SELECT originKey FROM submissions WHERE id = ? AND kind = 'station' AND action = 'upsert' AND status = 'approved'").get(removal.submissionId)
      : undefined;
    const versionKey = version ? (batch.channel === 'feishu' ? feishuHostnameKey(version.originKey as string) : version.originKey) : undefined;
    const intent = { index: index + 1, action, slug, removable: target?.source === 'submission' || versionKey === key };
    const previous = stationOrigins.get(key) ?? [];
    const conflict = previous.find(existing => !(existing.action === 'remove' && action === 'remove'
      && existing.removable && intent.removable && existing.slug !== slug));
    if (conflict) throw new ApiError(400, 'INVALID_INPUT', `第 ${conflict.index} 条与第 ${index + 1} 条站点 hostname 冲突：${key}`);
    previous.push(intent);
    stationOrigins.set(key, previous);
  }
  const results: AdminBatchSubmitResponse['results'] = batch.items.map(item => {
    try {
      validatePayload(store, item.kind, item.payload, item.action ?? 'upsert');
      const { submission, deduplicated, autoApproved } = enqueueSubmission(store, { ...item, batchId, channel: batch.channel, ip: input.ip, now: input.now });
      // 返回请求里的 key 以便逐条对账；记录里的站点 key 已由服务端规范化。
      return { originKey: item.originKey, kind: item.kind, id: submission.id, status: submission.status, deduplicated, autoApproved };
    } catch (error) {
      // 另一个写入方可能在预检后认领新 batchId，事务内发现时仍返回整批 409。
      if (error instanceof ApiError && (error.code === 'BATCH_CHANNEL_MISMATCH' || error.code === 'BATCH_ALREADY_REVIEWED')) throw error;
      if (error instanceof ApiError) return { originKey: item.originKey, kind: item.kind, error: { code: error.code, message: error.message } };
      throw error;
    }
  });
  return { batchId, results };
}

export function listSubmissions(store: Store, input: {
  status?: SubmissionStatus;
  kind?: SubmissionKind;
  batchId?: string;
  page?: number;
  pageSize?: number;
}) {
  const { status, kind, batchId, page, pageSize } = parse(submissionQuerySchema, input);
  const filters: string[] = [];
  const params: SqlValue[] = [];
  if (status) { filters.push('status = ?'); params.push(status); }
  if (kind) { filters.push('kind = ?'); params.push(kind); }
  if (batchId) { filters.push('batchId = ?'); params.push(batchId); }
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

/** 物化和版本查重沿用同一首次认领规则，只有飞书批次归并 www。 */
/**
 * 按 hostname 找站点。
 * hostname 是从 url 派生的，没有独立索引，所以这里每次都会全表扫描并解析 JSON。
 * 单条审核无所谓；批量审核 n 条、库里有 m 个站点时是 O(n·m)——实测 600 条 + 大量站点
 * 时一个批次要十几秒。当前站点规模（几十个）下无感，若将来批量审核变慢，先从这里下手：
 * 为 entities 增加 hostname 列并建索引，或让批次审核复用一个可增量的索引。
 */
function findStation(store: Store, submission: Pick<SubmissionRecord, 'channel' | 'batchId' | 'originKey'>, url: string): StationRecord | undefined {
  const hostname = hostnameOf(url);
  if (hostname === null) return undefined;
  const grouped = submission.channel === 'feishu' && submission.batchId !== null
    && feishuHostnameKey(submission.originKey) === feishuHostnameKey(hostname);
  return store.all('station').find(station => {
    const host = hostnameOf(station.url);
    return host !== null && (grouped ? feishuHostnameKey(host) === feishuHostnameKey(hostname) : host === hostname);
  });
}

/**
 * 站点 slug：`sub-` 加归一化 hostname 的可读形式。
 * hostname 超过长度上限、或清洗后与另一个站点撞车时，改用哈希后缀保证唯一——
 * 否则两个不同站点会写到同一条记录上，后审的覆盖先审的。
 * 身份一律取 url 的 hostname（不是 originKey），兼容以记录 ID 作为 originKey 的历史投稿，
 * 同一站点的重复提交仍然落在同一条记录上。
 * 派生规则来自 shared/slug.ts，飞书只传 hostname，由这里统一分配 slug。
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

export function parseStationPayload(store: Store, input: unknown) {
  const payload = parse(stationSchema, input);
  for (const offer of payload.offers) {
    if (!store.get('model', offer.modelSlug)) throw new ApiError(400, 'INVALID_INPUT', `未知模型：${offer.modelSlug}`);
  }
  return payload;
}

/** 入队校验与审核复用相同规则，批次中的无效内容逐条返回错误。 */
function validatePayload(store: Store, kind: SubmissionKind, payload: unknown, action: SubmissionRecord['action']): void {
  if (action === 'remove') {
    if (kind !== 'station') throw new ApiError(400, 'INVALID_INPUT', '只有站点支持下架');
    parse(removalSchema, payload);
  } else if (kind === 'model') parse(modelSchema, payload);
  else if (kind === 'station') parseStationPayload(store, payload);
  else parse(postSchema, payload);
}

/** 下架只允许群友来源，报价和实体共用调用方的审核事务，不另开事务。 */
export function removeStation(store: Store, slug: string, expectedSubmissionId: string): string | null {
  const station = store.get('station', slug);
  if (!station) return null;
  // 种子和演示数据不能被下架覆盖。其余来源都该能下线：
  // 飞书同步来的是 submission，Agent 提交的是 agent，
  // 只认 submission 会让 Agent 自动上架的站点永远删不掉。
  if (station.source === 'demo') throw new ApiError(409, 'STATION_SOURCE_CONFLICT', '演示数据不能下架');
  const originKey = new URL(parse(httpUrl, station.url)).hostname;
  const key = feishuHostnameKey(originKey);
  const current = store.db.prepare("SELECT id, originKey FROM submissions WHERE kind = 'station' AND action = 'upsert' AND status = 'approved' ORDER BY reviewedAt DESC, rowid DESC")
    .all().find(row => feishuHostnameKey(row.originKey as string) === key);
  if (current?.id !== expectedSubmissionId) throw new ApiError(409, 'STALE_REMOVAL', '该站点在读取后已被更新，请重新同步');
  // 软删除而不是真删：站点以自动运行为主，一次误读不该丢整批数据。
  // 报价保留（它们记的是这个站曾提供过什么），恢复时原样拿回来。
  // 同一个 slug 再上架时 put 会清掉标记，也就是自动恢复。
  store.markRemoved('station', slug, new Date().toISOString());
  return slug;
}

/** 只列出有 approved 飞书 upsert 的 hostname 组，并返回组内全部在线群友站点。 */
export function submissionState(store: Store): AdminSubmissionStateResponse {
  const feishuRows = store.db.prepare("SELECT * FROM submissions WHERE kind = 'station' AND channel = 'feishu' AND action = 'upsert' AND status = 'approved' ORDER BY reviewedAt DESC, rowid DESC").all();
  const feishuHosts = new Set<string>();
  for (const row of feishuRows) {
    const submission = submissionRecord(row);
    const origin = feishuHostnameKey(submission.originKey);
    const payload = parse(stationSchema, submission.payload);
    const hostname = hostnameOf(payload.url);
    if (hostname !== null && origin === feishuHostnameKey(hostname)) feishuHosts.add(origin);
  }

  // 移除记录不改变同组其他遗留实体的版本；渠道更新仍会推进组的 upsert 版本。
  const approvedUpserts = store.db.prepare("SELECT id, originKey FROM submissions WHERE kind = 'station' AND action = 'upsert' AND status = 'approved' ORDER BY reviewedAt DESC, rowid DESC").all();
  const currentByHost = new Map<string, string>();
  for (const row of approvedUpserts) {
    const key = feishuHostnameKey(row.originKey as string);
    if (!currentByHost.has(key)) currentByHost.set(key, row.id as string);
  }

  const stations: AdminSubmissionStateResponse['stations'] = [];
  for (const station of store.all('station')) {
    if (station.source !== 'submission') continue;
    const originKey = hostnameOf(station.url);
    if (originKey === null) continue;
    const key = feishuHostnameKey(originKey);
    const submissionId = currentByHost.get(key);
    if (!feishuHosts.has(key) || !submissionId) continue;
    stations.push({ slug: station.slug, submissionId, originKey, url: station.url, name: station.name });
  }
  return { stations: stations.sort((a, b) => a.originKey.localeCompare(b.originKey) || a.slug.localeCompare(b.slug)) };
}

/** 把一条投稿写进 entities。不自己开事务，由调用方决定边界。 */
function materialize(store: Store, submission: SubmissionRecord, reviewedAt: string): string | undefined {
  if (submission.action === 'remove') {
    if (submission.kind !== 'station') throw new ApiError(400, 'INVALID_INPUT', '只有站点支持下架');
    const { slug, submissionId } = parse(removalSchema, submission.payload);
    if (removeStation(store, slug, submissionId) === null) {
      const reason = '站点已不存在，视为已下架';
      console.info(`站点 ${slug} ${reason}`);
      return reason;
    }
  } else if (submission.kind === 'model') {
    const payload = parse(modelSchema, submission.payload);
    if (!store.get('vendor', payload.vendor)) throw new ApiError(400, 'INVALID_INPUT', `厂商 ${payload.vendor} 不存在，请先新增厂商`);
    // 已存在的模型直接覆盖会静默改写名称和厂商、并清空 tags，与新增接口的 409 不一致。
    if (store.get('model', payload.slug)) throw new ApiError(409, 'MODEL_EXISTS', `模型 ${payload.slug} 已存在，请拒绝这条投稿；如需改名请用 PATCH /api/admin/models/:slug`);
    store.put('model', payload.slug, { ...payload, tags: [] });
  } else if (submission.kind === 'station') {
    const { offers, ...payload } = parseStationPayload(store, submission.payload);
    // 飞书批次沿用旧同步的 www 分组，认领原站点；新 slug 仍统一由 stationSlug 分配。
    const mine = findStation(store, submission, payload.url);
    const slug = mine?.slug ?? stationSlug(store, payload.url, submission.originKey);
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
    // 飞书每次同步都会生成新批次，评价按原记录更新，不能每同步一次就多发一篇文章。
    const first = submission.channel === 'feishu' && submission.batchId !== null
      ? store.db.prepare("SELECT id FROM submissions WHERE kind = 'post' AND channel = 'feishu' AND originKey = ? AND status = 'approved' ORDER BY rowid LIMIT 1").get(submission.originKey)
      : undefined;
    const legacyId = `feishu-${submission.originKey}`;
    const legacy = submission.channel === 'feishu' && submission.batchId !== null && store.get('post', legacyId)?.source === 'submission';
    const postId = legacy ? legacyId : `sub-${first?.id ?? submission.id}`;
    store.put('post', postId, {
      id: postId, kind: 'review', title: payload.title, summary: payload.summary, body: payload.body,
      authorHandle: payload.authorHandle ?? 'anonymous-submission', authorNickname: payload.authorName,
      stationSlug, modelSlug: null, cover: null, publishedAt: payload.publishedAt ?? reviewedAt,
      status: 'approved', source: sourceByChannel[submission.channel],
    });
  }
}

/** 新版本上站后，同 key 的其他待审记录没有再审的意义。 */
/** 被新版本替代的旧投稿要给提交人一个能看懂的原因，否则 Agent 无法自我纠正。 */
const SUPERSEDED_REASON = '已被同一站点的更新版本替代，无需处理';

function supersedePending(store: Store, submission: SubmissionRecord, reviewedAt: string): void {
  const actionFilter = submission.action === 'remove' ? "AND action = 'upsert'" : '';
  store.db.prepare(`UPDATE submissions SET status = 'superseded', reason = ?, reviewedAt = ? WHERE kind = ? AND originKey = ? AND status = 'pending' AND id <> ? ${actionFilter}`)
    .run(SUPERSEDED_REASON, reviewedAt, submission.kind, submission.originKey, submission.id);
  if (submission.kind !== 'station') return;
  const key = feishuHostnameKey(submission.originKey);
  const aliases = [key, `www.${key}`].filter(host => host !== submission.originKey && feishuHostnameKey(host) === key);
  if (aliases.length === 0) return;
  if (submission.action === 'upsert') {
    const target = findStation(store, submission, parse(stationUrlSchema, submission.payload).url);
    const groupedTarget = store.all('station').find(station => {
      const host = hostnameOf(station.url);
      return host !== null && feishuHostnameKey(host) === key;
    });
    // Agent/web 可分别拥有 www 和裸域实体，只替代实际会更新当前实体的飞书批次。
    if (!target || groupedTarget?.slug !== target.slug) return;
  } else if (submission.channel !== 'feishu' || submission.batchId === null) return;
  for (const alias of aliases) {
    store.db.prepare(`UPDATE submissions SET status = 'superseded', reason = ?, reviewedAt = ? WHERE kind = 'station' AND channel = 'feishu' AND batchId IS NOT NULL AND originKey = ? AND status = 'pending' AND id <> ? ${actionFilter}`)
      .run(SUPERSEDED_REASON, reviewedAt, alias, submission.id);
  }
}

export function reviewSubmission(store: Store, now: Date, id: string, decision: {
  status: 'approved' | 'rejected';
  reason?: string;
}): SubmissionRecord {
  const { status, reason } = parse(submissionReviewSchema, decision);
  const reviewedAt = parse(z.date(), now).toISOString();
  try {
    return store.transaction(() => {
      const row = store.db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', '投稿不存在');
      const submission = submissionRecord(row);
      if (submission.status !== 'pending') throw new ApiError(409, 'ALREADY_REVIEWED', '投稿已审核或被新版本替代');

      let resolvedReason = reason ?? null;
      let materializationReason: string | undefined;
      if (status === 'approved') {
        // 历史 pending 也采用 URL 身份，避免审核后仍用旧 key 绕过下架版本校验。
        if (submission.kind === 'station' && submission.action === 'upsert') submission.originKey = submissionOriginKey(store, submission);
        materializationReason = materialize(store, submission, reviewedAt);
        resolvedReason = materializationReason ?? resolvedReason;
      }

      store.db.prepare('UPDATE submissions SET status = ?, autoApproved = 0, originKey = ?, reason = ?, reviewedAt = ? WHERE id = ?').run(status, submission.originKey, resolvedReason, reviewedAt, id);
      // 已不存在的目标没有产生新版本，不能借清理旧下架请求替代新的待审投稿。
      if (status === 'approved' && materializationReason === undefined) supersedePending(store, submission, reviewedAt);
      return { ...submission, status, reason: resolvedReason, reviewedAt };
    });
  } catch (error) {
    // 物化失败时事务已回滚。记录要是留在 pending 就再没人能动它：
    // 批次永远「还有待审的」，同批重跑被静默吞掉；
    // Agent 的待审配额统计全部 pending 行，几条必然失败的记录就能锁死一个账号，
    // 全局吃满后所有 Agent 投稿停摆。所以物化失败必须落终态。
    if (error instanceof ApiError && error.status !== 409 && error.status !== 404) {
      store.db.prepare("UPDATE submissions SET status = 'rejected', reason = ?, reviewedAt = ? WHERE id = ? AND status = 'pending'")
        .run(`审核时无法物化：${error.message}`.slice(0, 1000), reviewedAt, id);
    }
    throw error;
  }
}
