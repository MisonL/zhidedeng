import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { AgentRateQuota, AgentSubmitResponse, GetAgentStatusResponse, SubmissionKind } from '@zhidedeng/shared';
import { activeAgentHandle } from './agent-auth.ts';
import { AttemptLimiter } from './auth.ts';
import type { Store } from './database.ts';
import { ApiError } from './errors.ts';
import { enqueueSubmission, parseStationPayload, parseSubmissionInput, postSchema, stationSchema } from './submissions.ts';

const HOUR_MS = 3_600_000;
const TOKEN_PER_HOUR = 10;
const ACCOUNT_PER_HOUR = 20;
const IP_PER_HOUR = 20;
const ACCOUNT_PENDING = 5;
const HOSTNAME_PENDING = 2;
const GLOBAL_PENDING = 200;
// 幂等命中单独记一个宽松额度。重试不该把 Agent 的常规额度吃光，
// 但无脑重放同一个请求同样要能被限住。
const DEDUPE_PER_HOUR = 100;
const agentStationSchema = stationSchema.strict();
const agentPostSchema = postSchema.omit({ authorHandle: true }).strict();
const statusQuerySchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(50).default(20) });
const forbidden = new Set([
  'uptime', 'firsttokenlatencyms', 'foundedat', 'status', 'score', 'lowestrate',
  'apikey', 'token', 'password', 'secret', 'authorhandle',
  'accesstoken', 'refreshtoken', 'clientsecret', 'privatekey', 'authorization', 'credentials',
]);

export interface AgentRequest {
  handle: string;
  tokenHash: string;
  ip: string;
  now: Date;
}

/** 在 schema 丢弃未知字段之前检查所有层级，不扫描纯文本内容。 */
function rejectForbiddenFields(input: unknown) {
  const pending: { value: unknown; path: string }[] = [{ value: input, path: '' }];
  while (pending.length > 0) {
    const { value, path } = pending.pop()!;
    if (typeof value !== 'object' || value === null) continue;
    for (const [key, child] of Object.entries(value)) {
      const field = path ? `${path}.${key}` : key;
      if (forbidden.has(key.replace(/[_-]/g, '').toLowerCase())) {
        throw new ApiError(400, 'FORBIDDEN_FIELD', `Agent 投稿不允许字段 ${field}`);
      }
      pending.push({ value: child, path: field });
    }
  }
}

function objectPayload(input: unknown): Record<string, unknown> {
  rejectForbiddenFields(input);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ApiError(400, 'INVALID_INPUT', '投稿内容必须是 JSON 对象');
  }
  return input as Record<string, unknown>;
}

/** 把 IPv6 的两个 16 位分组还原成点分 IPv4，用于识别内嵌 IPv4 的转换前缀。 */
function wordsToIpv4(high: number, low: number): number[] {
  return [high >> 8, high & 255, low >> 8, low & 255];
}

function privateIpv4(parts: number[]): boolean {
  const [first, second] = parts;
  return first === 0 || first === 10 || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168) || (first === 169 && second === 254)
    // 运营商级 NAT、基准测试网段、文档保留段、组播与保留段都不能作为公开站点目标。
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 192 && second === 0) || (first === 198 && second === 51) || (first === 203 && second === 113)
    || first >= 224;
}

function privateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === 'localhost.localdomain' || host === 'local' || host === 'internal'
    || ['.localhost', '.local', '.internal', '.example'].some(suffix => host.endsWith(suffix))) return true;
  const version = isIP(host);
  if (version === 4) return privateIpv4(host.split('.').map(Number));
  if (version !== 6) return false;
  // WHATWG URL 已将 IPv4 的简写、整数、八进制和 IPv6 内嵌 IPv4 规范化。
  const [head, tail] = host.split('::');
  const leading = head ? head.split(':') : [];
  const trailing = tail ? tail.split(':') : [];
  const groups = host.includes('::') ? [...leading, ...Array<string>(8 - leading.length - trailing.length).fill('0'), ...trailing] : leading;
  const words = groups.map(group => parseInt(group, 16));
  if ((words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xffc0) === 0xfec0) return true;
  // 未指定、回环和旧 IPv4-compatible 地址都不能作为公网目标。
  if (words.slice(0, 6).every(word => word === 0)) return true;
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return privateIpv4(wordsToIpv4(words[6]!, words[7]!));
  }
  // NAT64 `64:ff9b::/96`：末尾 32 位是 IPv4。`[64:ff9b::7f00:1]` 经 NAT64 网关
  // 到达的就是 127.0.0.1，只看字面前缀会把它当成公网地址放行。
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every(word => word === 0)) {
    return privateIpv4(wordsToIpv4(words[6]!, words[7]!));
  }
  // 6to4 `2002::/16`：第 2、3 个分组嵌入 IPv4。
  if (words[0] === 0x2002) return privateIpv4(wordsToIpv4(words[1]!, words[2]!));
  return false;
}

function agentUrl(input: unknown, field = 'url'): string {
  if (typeof input !== 'string') throw new ApiError(400, 'INVALID_INPUT', `${field} 必须是 http/https 网址`);
  let url: URL;
  try { url = new URL(input); } catch { throw new ApiError(400, 'INVALID_INPUT', `${field} 不是有效网址`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ApiError(400, 'INVALID_INPUT', `${field} 只允许 http/https`);
  const hostname = url.hostname.replace(/\.+$/, '');
  if (!hostname || privateHostname(hostname)) throw new ApiError(400, 'INVALID_INPUT', `${field} 不允许内网、回环或本地地址`);
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
  private readonly byToken = new AttemptLimiter(TOKEN_PER_HOUR, HOUR_MS);
  private readonly byAccount = new AttemptLimiter(ACCOUNT_PER_HOUR, HOUR_MS);
  private readonly byIp = new AttemptLimiter(IP_PER_HOUR, HOUR_MS);
  private readonly byDedupe = new AttemptLimiter(DEDUPE_PER_HOUR, HOUR_MS);

  constructor(store: Store) { this.store = store; }

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
    for (const { limiter, key } of dimensions) limiter.record(key, time);
    return () => { for (const { limiter, key } of dimensions) limiter.release(key); };
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
          if (this.pendingCount() >= GLOBAL_PENDING) {
            throw new ApiError(409, 'TOO_MANY_PENDING', `全局待审队列已达 ${GLOBAL_PENDING} 条，暂停接收新投稿`);
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
