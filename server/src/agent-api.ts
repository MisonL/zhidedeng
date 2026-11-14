import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { isPrivateHostname } from '@zhidedeng/shared';
import type { AgentRateQuota, AgentSubmitResponse, GetAgentStatusResponse, SubmissionKind } from '@zhidedeng/shared';
import { agentModelSchema, agentPostSchema, agentStationSchema, findForbiddenAgentField } from '@zhidedeng/shared/submission';
import { activeAgentHandle } from './agent-auth.ts';
import { AttemptLimiter } from './auth.ts';
import type { Store } from './database.ts';
import { ApiError } from './errors.ts';
import {
  enqueueSubmission, GLOBAL_PENDING, parseStationPayload, parseSubmissionInput, postSchema, stationSchema,
} from './submissions.ts';

const HOUR_MS = 3_600_000;
const TOKEN_PER_HOUR = 10;
const ACCOUNT_PER_HOUR = 20;
const IP_PER_HOUR = 20;
const ACCOUNT_PENDING = 5;
const HOSTNAME_PENDING = 2;
// 幂等命中单独记一个宽松额度。重试不该把 Agent 的常规额度吃光，
// 但无脑重放同一个请求同样要能被限住。
const DEDUPE_PER_HOUR = 100;
const statusQuerySchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(50).default(20) });

export interface AgentRequest {
  handle: string;
  tokenHash: string;
  ip: string;
  now: Date;
}

/** 在 schema 丢弃未知字段之前检查所有层级，不扫描纯文本内容。规则与 zd CLI 共用。 */
function rejectForbiddenFields(input: unknown) {
  const field = findForbiddenAgentField(input);
  if (field !== null) throw new ApiError(400, 'FORBIDDEN_FIELD', `Agent 投稿不允许字段 ${field}`);
}

function objectPayload(input: unknown): Record<string, unknown> {
  rejectForbiddenFields(input);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ApiError(400, 'INVALID_INPUT', '投稿内容必须是 JSON 对象');
  }
  return input as Record<string, unknown>;
}

function agentUrl(input: unknown, field = 'url'): string {
  if (typeof input !== 'string') throw new ApiError(400, 'INVALID_INPUT', `${field} 必须是 http/https 网址`);
  let url: URL;
  try { url = new URL(input); } catch { throw new ApiError(400, 'INVALID_INPUT', `${field} 不是有效网址`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ApiError(400, 'INVALID_INPUT', `${field} 只允许 http/https`);
  const hostname = url.hostname.replace(/\.+$/, '');
  if (!hostname || isPrivateHostname(hostname)) throw new ApiError(400, 'INVALID_INPUT', `${field} 不允许内网、回环或本地地址`);
  url.hostname = hostname;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function postHostname(hostname: string): string {
  const normalized = new URL(agentUrl(`https://${hostname}`, 'hostname'));
  // hostname 可以带端口，但不能夹带 URL 的路径、账号或查询部分。
  const raw = new URL(`https://${hostname}`);
  if (raw.username || raw.password || raw.pathname !== '/' || raw.search || raw.hash) {
    throw new ApiError(400, 'INVALID_INPUT', 'hostname 只能包含主机名和可选端口');
  }
  return normalized.hostname;
}

const HOSTNAME_SQL = "CASE WHEN kind = 'station' THEN rtrim(lower(originKey), '.') WHEN kind = 'post' THEN rtrim(lower(json_extract(payload, '$.hostname')), '.') END";

export class AgentApi {
  private readonly store: Store;
  private readonly byToken: AttemptLimiter;
  private readonly byAccount: AttemptLimiter;
  private readonly byIp: AttemptLimiter;
  private readonly byDedupe: AttemptLimiter;

  constructor(store: Store) {
    this.store = store;
    // 计数落库，量级很小（每次提交几条），换来多进程下配额仍然成立。
    this.byToken = new AttemptLimiter(TOKEN_PER_HOUR, HOUR_MS, store, 'agent-token');
    this.byAccount = new AttemptLimiter(ACCOUNT_PER_HOUR, HOUR_MS, store, 'agent-account');
    this.byIp = new AttemptLimiter(IP_PER_HOUR, HOUR_MS, store, 'agent-ip');
    this.byDedupe = new AttemptLimiter(DEDUPE_PER_HOUR, HOUR_MS, store, 'agent-dedupe');
  }

  submitStation(input: unknown, request: AgentRequest): AgentSubmitResponse {
    const raw = objectPayload(input);
    const payload = parseStationPayload(this.store, parseSubmissionInput(agentStationSchema, { ...raw, url: agentUrl(raw.url) }));
    const hostname = new URL(payload.url).hostname;
    return this.enqueue('station', payload, hostname, hostname, request);
  }

  submitPost(input: unknown, request: AgentRequest): AgentSubmitResponse {
    const parsed = parseSubmissionInput(agentPostSchema, objectPayload(input));
    const hostname = parsed.hostname == null ? null : postHostname(parsed.hostname);
    // IDN 规范化可能增加长度，派生出的最终 payload 仍须满足审核使用的 schema。
    const payload = parseSubmissionInput(postSchema, { ...parsed, hostname, publishedAt: parsed.publishedAt ?? null, authorHandle: request.handle });
    // 评价没有上游记录 ID，用规范化内容和账号生成稳定的 originKey；不把当前时间混入 payload。
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return this.enqueue('post', payload, `agent:${request.handle}:${hash}`, hostname ?? null, request);
  }

  /**
   * 补录模型。模型没有上游记录，originKey 用 slug 本身：
   * 同一个 slug 重复提交必须幂等命中，否则每跑一次就多一条待审。
   */
  submitModel(input: unknown, request: AgentRequest): AgentSubmitResponse {
    const payload = parseSubmissionInput(agentModelSchema, objectPayload(input));
    // 厂商必须已存在。物化时才校验的话，一条注定失败的投稿会先占掉待审配额，
    // 提交方却看不到任何反馈。
    if (!this.store.get('vendor', payload.vendor)) throw new ApiError(400, 'INVALID_INPUT', `厂商不存在：${payload.vendor}`);
    return this.enqueue('model', payload, `model:${payload.slug}`, null, request);
  }

  private pendingCount(handle?: string): number {
    const where = handle === undefined ? '' : ' AND actorHandle = ?';
    return Number(this.store.db.prepare(`SELECT count(*) AS count FROM submissions WHERE status = 'pending'${where}`)
      .get(...(handle === undefined ? [] : [handle]))!.count);
  }

  private hostnameCount(hostname: string): number {
    return Number(this.store.db.prepare(`SELECT count(*) AS count FROM submissions WHERE status = 'pending' AND (${HOSTNAME_SQL}) = ?`)
      .get(hostname)!.count);
  }

  private reserve(request: AgentRequest): () => void {
    const time = request.now.getTime();
    const dimensions = [
      { name: '单 token', limiter: this.byToken, key: request.tokenHash },
      { name: '单账号', limiter: this.byAccount, key: request.handle },
      { name: '单 IP', limiter: this.byIp, key: request.ip },
    ];
    const limited = dimensions.map(dimension => ({ ...dimension, retryAfter: dimension.limiter.retryAfter(dimension.key, time) }))
      .filter(dimension => dimension.retryAfter > 0);
    if (limited.length > 0) {
      throw new ApiError(429, 'RATE_LIMITED', `${limited.map(dimension => dimension.name).join('、')}每小时提交次数已达上限，请稍后重试`,
        { retryAfter: Math.max(...limited.map(dimension => dimension.retryAfter)) });
    }
    // 从预占到入队结束都是同步代码，没有 await；失败时撤销本次预占。
    // 必须记住每条预占的句柄：入队事务回滚后那几行已经不存在了，
    // 若按「删最新一条」撤销，删掉的是上一次成功的记录，配额会被无限释放。
    const handles = dimensions.map(({ limiter, key }) => ({ limiter, key, id: limiter.record(key, time) }));
    return () => { for (const { limiter, key, id } of handles) limiter.release(key, id); };
  }

  /**
   * 命中幂等：把刚预占的常规额度退回去，改记一次去重额度。
   * 去重额度用尽才返回 429——这样正常重试不受影响，反复探测被限住。
   */
  private refundAsDedupe(request: AgentRequest, release?: () => void): void {
    const time = request.now.getTime();
    release?.();
    const retryAfter = this.byDedupe.retryAfter(request.tokenHash, time);
    if (retryAfter > 0) {
      throw new ApiError(429, 'RATE_LIMITED', '重复提交次数过多，请稍后重试', { retryAfter });
    }
    this.byDedupe.record(request.tokenHash, time);
  }

  private enqueue(kind: SubmissionKind, payload: unknown, originKey: string, hostname: string | null, request: AgentRequest): AgentSubmitResponse {
    // JSON 正文读取期间可能发生禁用或吊销，不能仅依赖读取前的校验。
    activeAgentHandle(this.store, request.tokenHash);
    let release: (() => void) | undefined;
    try {
      const result = enqueueSubmission(this.store, {
        kind, channel: 'agent', originKey, batchId: null, payload, actorHandle: request.handle, ip: request.ip, now: request.now,
      }, {
        deduplicateByActor: true,
        // 去重早退发生在 beforeInsert 之后，预占要在这里退掉。
        onDeduplicated: () => { this.refundAsDedupe(request, release); },
        beforeInsert: () => {
          activeAgentHandle(this.store, request.tokenHash);
          if (this.pendingCount(request.handle) >= ACCOUNT_PENDING) {
            throw new ApiError(409, 'TOO_MANY_PENDING', `单账号待审投稿已达 ${ACCOUNT_PENDING} 条，请等待审核`);
          }
          if (hostname !== null && this.hostnameCount(hostname) >= HOSTNAME_PENDING) {
            throw new ApiError(409, 'TOO_MANY_PENDING', `单 hostname ${hostname} 的待审投稿已达 ${HOSTNAME_PENDING} 条，请等待审核`);
          }
          release = this.reserve(request);
        },
      });
      // 自动通过开启时如实返回 true，此时 submission.status 已经是 approved。
      return { ...result, autoApproved: result.autoApproved };
    } catch (error) {
      release?.();
      throw error;
    }
  }

  status(request: AgentRequest, query: unknown): GetAgentStatusResponse {
    const { limit } = parseSubmissionInput(statusQuerySchema, query);
    const time = request.now.getTime();
    const rateQuota = (limiter: AttemptLimiter, key: string, max: number): AgentRateQuota => ({
      limit: max, remaining: limiter.remaining(key, time), retryAfter: limiter.retryAfter(key, time),
    });
    return this.store.transaction(() => {
      const pendingCount = this.pendingCount(request.handle);
      const hostnames = this.store.db.prepare(`SELECT DISTINCT (${HOSTNAME_SQL}) AS hostname FROM submissions
        WHERE actorHandle = ? AND status = 'pending' ORDER BY hostname`).all(request.handle)
        .filter((row): row is { hostname: string } => typeof row.hostname === 'string' && row.hostname.length > 0)
        .map(({ hostname }) => {
          const count = this.hostnameCount(hostname);
          return { hostname, pendingCount: count, limit: HOSTNAME_PENDING, remaining: Math.max(0, HOSTNAME_PENDING - count) };
        });
      const rows = this.store.db.prepare('SELECT id, kind, status, createdAt, reason FROM submissions WHERE actorHandle = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?')
        .all(request.handle, limit);
      return {
        handle: request.handle, pendingCount,
        quotas: {
          token: rateQuota(this.byToken, request.tokenHash, TOKEN_PER_HOUR),
          account: rateQuota(this.byAccount, request.handle, ACCOUNT_PER_HOUR),
          ip: rateQuota(this.byIp, request.ip, IP_PER_HOUR),
          pending: { limit: ACCOUNT_PENDING, remaining: Math.max(0, ACCOUNT_PENDING - pendingCount) },
          globalPending: { limit: GLOBAL_PENDING, remaining: Math.max(0, GLOBAL_PENDING - this.pendingCount()) },
          hostnames,
        },
        submissions: rows as unknown as GetAgentStatusResponse['submissions'],
      };
    });
  }
}
