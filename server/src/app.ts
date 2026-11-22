import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';
import { API_ROUTES, MAX_RATE, MIN_RATE, PROFILE_LIMITS } from '@zhidedeng/shared';
import type { ApiContracts, ApiRouteName, ChangePasswordRequest, LoginRequest, RegisterRequest } from '@zhidedeng/shared';
import { modelSchema, rateBasis } from '@zhidedeng/shared/submission';
import { AttemptLimiter, burnPasswordCheck, clearedSessionCookie, createSession, deleteOtherSessions, deleteSession, hashPassword, INITIAL_TOKENS, isWeakPassword, sessionCookie, sessionHandle, USERNAME, verifyPassword } from './auth.ts';
import { agentTokenSchema, createAgentToken, listAgentTokens, revokeAgentToken } from './agent-tokens.ts';
import { agentHandle, agentTokenHash } from './agent-auth.ts';
import { AgentApi } from './agent-api.ts';
import { authorizeAdmin, adminSlug, createModel, createVendor, deleteModel, importResponse, updateModel } from './catalog.ts';
import type { Store } from './database.ts';
import { Service, isReservedNickname, normalizeNickname } from './service.ts';
import { ApiError, isDatabaseBusyError } from './errors.ts';
import { createInviteCode, listInviteCodes, revokeInviteCode } from './invite-codes.ts';
import { listPosts, restorePost, reviewPost, setAccountDisabled, setCommentHidden, withdrawPost } from './moderation.ts';
import { autoApproveEnabled, enqueueBatch, enqueueSubmission, listSubmissions, reviewSubmission, setAutoApprove, submissionBatchReviewSchema, submissionBatchSchema, submissionQuerySchema, submissionReviewSchema, submissionState } from './submissions.ts';

/**
 * GET 参数归一。schema 是 strictObject 的，未知键会让整页 400，
 * 但对读接口来说多一个统计参数就整页失败显然不合理——直接丢掉未知键。
 * 空串按「没传」处理，否则 `?vendor=` 会命中 min(1) 校验。
 */
function normalizeQuery(schema: z.ZodType<unknown>, query: Record<string, string>): Record<string, string> {
  const shape = schema instanceof z.ZodObject ? Object.keys(schema.shape) : null;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === '') continue;
    if (shape && !shape.includes(key)) continue;
    result[key] = value;
  }
  return result;
}

const pagination = {
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  pageSize: z.coerce.number().int().min(1).transform(size => Math.min(size, 50)).optional(),
};
const queryText = z.string().trim().max(200).optional();
const identifier = z.string().trim().min(1).max(200);
const target = { targetType: z.enum(['post', 'station']), targetId: identifier };
const kind = z.enum(['deal', 'review', 'community', 'guide']);
const nickname = z.string().trim().min(1).max(PROFILE_LIMITS.nickname);
const registerSchema: z.ZodType<RegisterRequest> = z.strictObject({ username: z.string().regex(USERNAME), password: z.string().min(8).max(128), nickname: nickname.optional() });
const loginSchema: z.ZodType<LoginRequest> = z.strictObject({ username: z.string().min(1).max(100), password: z.string().min(1).max(128) });

const changePasswordSchema: z.ZodType<ChangePasswordRequest> = z.strictObject({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(8).max(128) });

const LOGIN_WINDOW_MS = 15 * 60_000;
const REGISTER_WINDOW_MS = 60 * 60_000;
// 邀请码是长期有效的共享秘密，必须限制同一把凭证被多少个新号兑换、每个新号试几次。
const INVITE_WINDOW_MS = 60 * 60_000;
const INVITE_PER_CODE_LIMIT = 20;
const AGENT_TOKEN_WINDOW_MS = 60 * 60_000;
const AGENT_TOKEN_PER_USER = 10;
const AGENT_TOKEN_PER_IP = 30;
// 签到一天只能成功一次，5 次/小时够覆盖手滑和网络重试，脚本刷不起来。
const CHECKIN_WINDOW_MS = 60 * 60_000;
const CHECKIN_PER_USER = 5;

//投票与收藏按用户滑窗限流：主键去重挡不住「反复切换值」的刷量写事务，
//每次调用都全表扫描互动数据，不设闸会被低成本压库。
const VOTE_WINDOW_MS =60_000;
const VOTE_PER_USER = 30;

// 这些读接口只有本人的数据，未登录直接 401。
const PERSONAL_READS = new Set<ApiRouteName>(['getMe', 'getMyFavorites', 'getMyPosts']);

// 投稿正文上限 10 万字，UTF-8 最多 30 万字节。
const API_BODY_BYTES = 512 * 1024;
const IMPORT_BODY_BYTES = 8 * 1024 * 1024;
const IMPORT_PATH = '/api/admin/import';
const SUBMISSION_BATCH_PATH = '/api/admin/submissions/batch';
const postStatus = z.enum(['pending', 'approved', 'rejected']);

export interface AppOptions {
  secureCookie?: boolean;
  // 导入和管理接口的 Bearer 密钥；未配置时这些接口一律拒绝。
  syncToken?: string;
  inviteCodes?: readonly string[];
  /**
   * 额外信任的反向代理地址（逗号分隔的 IP 或 CIDR）。
   * 默认只信回环——直连方是 nginx 时才用 X-Forwarded-For。
   * 容器部署时请求从 Docker 网桥（如 172.17.0.1）进来，不配这个就会让
   * 所有用户的 IP 限流落进同一个桶。
   */
  trustedProxies?: string;
  /**
   * 前端构建产物目录。有它时健康检查会顺带确认 index.html 存在——
   * 容器里只有 `SELECT 1` 的话，前端文件缺失/挂载失败时健康检查照样通过，
   * deploy.sh 会报告「部署完成」，而用户打开是白屏。
   */
  webRoot?: string;
}

interface Bindings {
  incoming?: { socket: { remoteAddress?: string } };
}
type AppContext = Context<{ Bindings: Bindings }>;

/** 限流键。IPv6 用户通常握有整个 /64，按单个地址计数等于没限。 */
/**
 * IPv4 逐段转数值再拼回去。非法输入原样返回（它不可能是合法 IP，
 * 归一化没有意义，也不该在这里抛错——上游已经做过 isIpLiteral 校验）。
 */
function canonicalIpv4(value: string): string {
  const parts = value.split('.');
  if (parts.length !== 4) return value;
  const bytes = parts.map(part => (/^\d+$/.test(part) ? Number(part) : NaN));
  if (bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return value;
  return bytes.join('.');
}

export function normalizeIp(ip: string) {
  // 去端口（`1.2.3.4:5678`）与 IPv6 尾点。X-Forwarded-For 里出现端口是常见的，
  // 而 `1.2.3.4:5678` 与 `1.2.3.4:5679` 会被当成两个桶——每换一个源端口就重置配额。
  let value = ip.trim();
  const v4Port = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/);
  if (v4Port) value = v4Port[1];
  value = value.replace(/\.+$/, '');
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return canonicalIpv4(mapped[1]);
  // 纯 IPv4 必须做数值归一：`198.51.100.7`、`0198.51.100.7`、`198.051.100.007`
  // 是同一个地址，但作为字符串是三个键，轮着写就能把按 IP 的限流整个绕开。
  if (!value.includes(':')) return canonicalIpv4(value);
  const address = value.toLowerCase().split('%')[0];
  const [head, tail] = address.split('::');
  const leading = head ? head.split(':') : [];
  const trailing = tail ? tail.split(':') : [];
  // 分组数要夹在 0..8 之间再做减法和 Array()。
  // 原先直接写 Array(8 - leading.length - trailing.length)：`1:2:3:4:5:6:7:8::9:2:3:4:5:6:7:8`
  // 这种畸形输入会让长度变成负数，Node 抛 RangeError: Invalid array length，
  // 一路冒到 500——而它来自客户端完全可控的 X-Forwarded-For 头。
  if (!address.includes('::')) return `${leading.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
  const width = Math.max(0, 8 - leading.length - trailing.length);
  const groups = [...leading, ...Array<string>(width).fill('0'), ...trailing];
  return `${groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    result = result * 256 + byte;
  }
  return result;
}

/** 判断直连方是否属于可信反代网段。只处理 IPv4 的 IP 与 CIDR，够覆盖容器与常见反代。 */
export function isTrustedProxy(remote: string | undefined, trusted: string): boolean {
  if (!remote) return false;
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true;
  const address = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
  const target = ipv4ToInt(address);
  if (target === null) return false;
  for (const raw of trusted.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const [base, bitsText] = entry.split('/');
    const bits = bitsText === undefined ? 32 : Number(bitsText);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const network = ipv4ToInt(base ?? '');
    if (network === null) continue;
    // 前缀比较：掩掉低位后相等，说明在同一个网络里。
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((network & mask) >>> 0) === ((target & mask) >>> 0)) return true;
  }
  return false;
}

/** 是否是合法 IP 字面量（v4 或 v6）。用来把伪造头里的垃圾段直接丢掉。 */
function isIpLiteral(value: string): boolean {
 //映射 IPv4（::ffff:1.2.3.4）必须做数值校验：只测字符形态的话
 //`::ffff:999.1.1.1` 会被放行，normalizeIp 归一出 `999.1.1.1`，攻击者
 //改末段就得到新桶——和端口后缀是同一类绕过。非法地址直接丢弃。
 const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
 if (mapped) return ipv4ToInt(mapped[1]) !== null;
 if (ipv4ToInt(value) !== null) return true;
 //到这里不是纯 v4 也不是映射 v4。带端口后缀的 v4（203.0.113.5:9999）含冒号、
 //其余字符都在十六进制/点集合里，会被下面的正则误判成 v6 字面量；段必须是 IP 本体。
 if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) return false;
 //v6 判据：真正合法的 v6 要么 ≥2 组冒号，要么含 ::（零压缩），否则
 //`a:999`、`deadbeef:88888888` 这类「一个冒号+数字尾巴」也会被放行。
 if (!value.includes(":")) return false;
 const colons = value.split(":").length -1;
 return (colons >=2 || value.includes("::")) && /^[0-9a-fA-F:.%]+$/.test(value);
}

/**
 * 直连方是可信反代时才用 X-Forwarded-For；其他情况用直连地址。
 *
 * 取最右一段：反代覆写 X-Forwarded-For 时最右就是真实客户端，左边全是客户端
 * 自己塞的。逐段做 IP 校验，非法段直接丢弃——否则限流键会变成任意字符串，
 * 换一次头就是一个新桶，等于把按 IP 的限流整个取消。
 *
 * 注意这条防线的前提是「可信反代确实覆写了这个头」。端口直映射进容器时前面
 * 没有任何代理，此时**不能**配置 TRUSTED_PROXIES，否则客户端自带的头会被
 * 原样采信。这是部署约定，启动日志会针对这个组合告警。
 */
function clientIp(c: AppContext, trustedProxies: string) {
  const remote = c.env?.incoming?.socket.remoteAddress;
  if (isTrustedProxy(remote, trustedProxies)) {
    const forwarded = (c.req.header('x-forwarded-for') ?? '')
      .split(',').map(part => part.trim()).filter(part => part !== '' && isIpLiteral(part));
    const candidate = forwarded.at(-1);
    if (candidate) return normalizeIp(candidate);
  }
  return normalizeIp(remote ?? 'unknown');
}

export function buildApp(store: Store, now: () => Date, options: AppOptions = {}) {
  const secureConfigured = options.secureCookie ?? false;
  const trustedProxies = options.trustedProxies ?? '';
  /**
   * TLS_ENABLED=1 就是运维在断言「本站对外是 HTTPS」，此时一律加 Secure。
   *
   * 早先还要求「直连方是可信反代」才加，导致 TLS_ENABLED=1 但 TRUSTED_PROXIES
   * 没配时静默降级成不带 Secure——HTTPS 站点上会话 cookie 会随任意明文请求
   * 一起发出去。这个组合很难自己发现，所以把两个条件解耦：只要声明了 TLS 就加。
   * 反过来的风险（声明了 TLS 实际走 http）由启动警告兜底，那种情况本来就登不上。
   */
  const cookieSecure = () => secureConfigured;
  const loginByTarget = new AttemptLimiter(5, LOGIN_WINDOW_MS, store, 'login-target');
  const loginByIp = new AttemptLimiter(30, LOGIN_WINDOW_MS, store, 'login-ip');
  // 不随 IP 变化：防多个 IP 轮流猜同一账号。代价是别人可以把某个账号暂时挡在登录外。
  const loginByUsername = new AttemptLimiter(20, LOGIN_WINDOW_MS, store, 'login-username');
  const passwordChangeByUser = new AttemptLimiter(5, LOGIN_WINDOW_MS, store, 'password-change');
  const registerByIp = new AttemptLimiter(10, REGISTER_WINDOW_MS, store, 'register-ip');
  // 按用户名维度限流：用户名是否被占用只能通过响应推断，所以必须让人没法
  // 大批量探测。20 次/小时足够正常用户改几次名，挡得住字典式枚举。
  const registerByUsername = new AttemptLimiter(20, REGISTER_WINDOW_MS, store, 'register-username');
  const inviteByCode = new AttemptLimiter(INVITE_PER_CODE_LIMIT, INVITE_WINDOW_MS, store, 'invite-code');
  const agentTokenByUser = new AttemptLimiter(AGENT_TOKEN_PER_USER, AGENT_TOKEN_WINDOW_MS, store, 'agent-token-user');
  const agentTokenByIp = new AttemptLimiter(AGENT_TOKEN_PER_IP, AGENT_TOKEN_WINDOW_MS, store, 'agent-token-ip');
  const agentApi = new AgentApi(store);
  // 签到是唯一「不限频 + 有写入 + 有奖励」的接口，之前完全没有闸门。
  const checkInByUser = new AttemptLimiter(CHECKIN_PER_USER, CHECKIN_WINDOW_MS, store, 'checkin-user');
 const voteByUser = new AttemptLimiter(VOTE_PER_USER, VOTE_WINDOW_MS, store, 'vote-user');

  const app = new Hono<{ Bindings: Bindings }>();
  // 压缩必须在这里注册——Hono 按注册顺序匹配，注册晚了就只覆盖之后的路由。
  // 上一版放在 mountWeb 里（该函数在 buildApp 之后才调用），结果只压了静态资源，
  // /api/* 的 JSON 全是原样传输：首屏 8 个接口合计 37KB，压完约 9KB。
  // nginx 模板里配了 gzip，但当前部署是容器端口直映射、前面没有 nginx。
  app.use('*', compress());
  // Hono 默认给每个响应加 `x-powered-by: Hono`。这只是把框架指纹送给扫描器，
  // 对本服务没有任何用途；顺手再给 API 响应补上不许嗅探内容的头。
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.delete('x-powered-by');
    c.res.headers.set('x-content-type-options', 'nosniff');
  });
  app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: '资源不存在' } }, 404));
  app.onError((error, c) => {
    if (isDatabaseBusyError(error)) return c.json({ error: { code: 'BUSY', message: '数据库繁忙，请重试' } }, 503);
    if (error instanceof ApiError) {
      const retryAfter = error.details?.retryAfter;
      if (error.status === 429 && typeof retryAfter === 'number') c.header('retry-after', String(retryAfter));
      return c.json({ error: { code: error.code, message: error.message, ...error.details } }, error.status);
    }
    if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: { code: 'INVALID_INPUT', message: '请求参数或 JSON 正文无效' } }, 400);
    console.error(error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' } }, 500);
  });

  const tooLarge = () => { throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体过大'); };
  const apiBodyLimit = bodyLimit({ maxSize: API_BODY_BYTES, onError: tooLarge });
  const importBodyLimit = bodyLimit({ maxSize: IMPORT_BODY_BYTES, onError: tooLarge });
  // 体积闸门必须排在 Content-Type 闸门之前：bodyLimit 只看 Content-Length、不读流，
  // 而下面的闸门一旦读流，超大请求就会先被完整读进内存，限制形同虚设。
  app.use('/api/*', (c, next) => ([IMPORT_PATH, SUBMISSION_BATCH_PATH].includes(c.req.path) ? importBodyLimit : apiBodyLimit)(c, next));

  // 跨站表单发不出 application/json，配合 SameSite=Lax 防 CSRF。
  // 带请求体的写接口必须有这个头；不带请求体的（DELETE、restore）允许没有，
  // 否则调用方按直觉发的 DELETE 会被拒，报错还指向一个它根本没打算发的正文。
  app.use('/api/*', async (c, next) => {
    const method = c.req.method;
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return next();
    if (/^application\/json\b/i.test(c.req.header('content-type') ?? '')) return next();
    // 用 Hono 的 c.req.text() 而不是 c.req.raw.text()：前者会缓存结果，
    // handler 再读时命中缓存，不会二次消费流（raw.text() 会抛 ERR_INVALID_STATE）。
    // bodyLimit 已在前一步按 Content-Length 拦过大请求，这里读进内存是安全的。
    // 必须按内容判断而不是只看头部：只看头会让不带长度头的传输路径绕过 CSRF 防线。
    const hasBody = method !== 'DELETE' && Boolean(await c.req.text().catch(() => ''));
    if (hasBody) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '写接口要求 Content-Type: application/json');
    await next();
  });

  app.get('/api/health', c => {
    // 数据库可达是底线；配了静态目录时再确认前端入口还在。
    store.db.prepare('SELECT 1').get();
    const checks: Record<string, string> = { database: 'ok' };
    if (options.webRoot) {
      const index = join(options.webRoot, 'index.html');
      if (!existsSync(index)) {
        checks.frontend = 'missing';
        return c.json({ status: 'degraded', checks }, 503);
      }
      checks.frontend = 'ok';
    }
    return c.json({ status: 'ok', checks });
  });

  // 管理接口：导入、审核投稿、隐藏评论。不进公开契约和 /docs，普通登录用户也没有权限。
  app.use('/api/admin/*', async (c, next) => {
    const denied = await authorizeAdmin(c.req.header('authorization'), options.syncToken);
    if (denied) return denied;
    await next();
  });
  app.post(IMPORT_PATH, async c => importResponse(store, await c.req.text()));
  app.post('/api/admin/models', async c => {
    const input = z.strictObject({
      slug: adminSlug,
      vendor: z.string().trim().min(1).max(64),
      name: z.string().trim().min(1).max(60),
      description: z.string().trim().min(1).max(200),
    }).parse(await c.req.json());
    return c.json(createModel(store, input));
  });
  app.patch('/api/admin/models/:slug', async c => {
    const input = z.strictObject({
      vendor: z.string().trim().min(1).max(64),
      name: z.string().trim().min(1).max(60),
      description: z.string().trim().min(1).max(200),
    }).parse(await c.req.json());
    return c.json(updateModel(store, c.req.param('slug'), input));
  });
  app.delete('/api/admin/models/:slug', async c => {
    z.strictObject({ confirm: z.literal(true) }).parse(await c.req.json());
    return c.json(deleteModel(store, c.req.param('slug')));
  });
  app.post('/api/admin/vendors', async c => {
    const input = z.strictObject({
      slug: adminSlug,
      name: z.string().trim().min(1).max(60),
      iconKey: adminSlug.optional(),
    }).parse(await c.req.json());
    return c.json(createVendor(store, input));
  });
  app.post('/api/admin/submissions', async c => {
    // 运维的单条入队入口，沿用与批次相同的审核和物化规则。
    const input = z.object({
      kind: z.enum(['station', 'model', 'post']),
      channel: z.enum(['feishu', 'agent', 'web']),
      originKey: z.string().trim().min(1).max(253),
      batchId: z.string().trim().min(1).max(200).nullish(),
      action: z.enum(['upsert', 'remove']).optional(),
      payload: z.unknown(),
      actorHandle: z.string().trim().max(200).nullish(),
    }).parse(await c.req.json());
    // 管理端手动入队，受信通道，不套用户侧熔断。
    return c.json(enqueueSubmission(store, { ...input, ip: clientIp(c, trustedProxies), now: now() }, { globalPendingBreaker: false }));
  });
  app.post(SUBMISSION_BATCH_PATH, async c => {
    const input = submissionBatchSchema.parse(await c.req.json());
    return c.json(enqueueBatch(store, { ...input, ip: clientIp(c, trustedProxies), now: now() }));
  });
  app.get('/api/admin/submissions/state', c => c.json(submissionState(store)));
  // 邀请码管理。这套接口和别的管理接口一样走 Bearer，不在公开契约里开放给浏览器会话。
  app.post('/api/admin/invite-codes', async c => {
    const input = z.strictObject({
      note: z.string().trim().max(100).optional(),
      maxUses: z.number().int().min(1).max(10_000).nullable().optional(),
      expiresAt: z.string().trim().min(1).max(40).nullable().optional(),
    }).parse(await c.req.json());
    const created = createInviteCode(store, input, now());
    return c.json({ code: created.code, inviteCode: created.record });
  });
  app.get('/api/admin/invite-codes', c => c.json({ items: listInviteCodes(store) }));
  app.post('/api/admin/invite-codes/:id/revoke', c => {
    const { id } = z.strictObject({ id: z.string().trim().min(1).max(200) }).parse(c.req.param());
    return c.json({ inviteCode: revokeInviteCode(store, id, now()) });
  });
  // 管理员重置密码：用户忘了密码又收不到邮件时唯一的补救手段。
  // 这是最高权限的操作，比改资料敏感得多，所以放在 /api/admin/ 下（nginx 默认只允许本机）。
  app.post('/api/admin/accounts/reset-password', async c => {
    const input = z.strictObject({
      username: z.string().trim().min(1).max(64),
      newPassword: z.string().min(1).max(128),
    }).parse(await c.req.json());
    const handle = store.db.prepare('SELECT handle FROM accounts WHERE usernameKey = ?')
      .get(input.username.toLowerCase())?.handle as string | undefined;
    if (!handle) throw new ApiError(404, 'NOT_FOUND', '这个用户名不存在');
    // 管理员显式设的密码同样要过强度判定：设成 welcome123 等于没重置。
    if (isWeakPassword(input.newPassword, handle)) throw new ApiError(400, 'WEAK_PASSWORD', '这个密码太容易被猜到，请换一个（避免常见词、连续字符或包含用户名）');
    // 哈希失败（比如 scrypt 因为负载被拒）时不改库，让调用方重试即可。
    const passwordHash = await hashPassword(input.newPassword);
    const revoked = store.transaction(() => {
      store.db.prepare('UPDATE accounts SET passwordHash = ? WHERE handle = ?').run(passwordHash, handle);
      // 全部会话都清掉，包括管理员自己的（如果他重置的是自己的账号）。
      // 会话是「已证明持有密码」的凭据，密码变了就必须失效。
      const sessions = store.db.prepare('DELETE FROM sessions WHERE handle = ?').run(handle) as { changes?: number };
      // Agent 凭证一起吊销。它是长期有效的 bearer token 且不过期，
      // 忘了密码的人多半也认为账号可能被盗——留着凭证等于留一把钥匙。
      const tokens = store.db.prepare('UPDATE agent_tokens SET revokedAt = ? WHERE handle = ? AND revokedAt IS NULL')
        .run(now().toISOString(), handle) as { changes?: number };
      return { sessions: Number(sessions.changes ?? 0), agentTokens: Number(tokens.changes ?? 0) };
    });
    // 只记账号与吊销数量，不记密码。
    console.info(JSON.stringify({ event: 'admin.reset-password', handle, ...revoked }));
    return c.json({ ok: true, handle, revokedSessions: revoked.sessions, revokedAgentTokens: revoked.agentTokens });
  });
  app.get('/api/admin/settings', c => c.json({ autoApprove: autoApproveEnabled(store) }));
  app.post('/api/admin/settings', async c => {
    const { autoApprove } = z.strictObject({ autoApprove: z.boolean() }).parse(await c.req.json());
    return c.json({ autoApprove: setAutoApprove(store, autoApprove, now()) });
  });
  app.get('/api/admin/submissions', c => {
    const query = submissionQuerySchema.parse({ ...c.req.query(), status: c.req.query('status') ?? 'pending' });
    return c.json(listSubmissions(store, query));
  });
  // 恢复误下架的站点。下架是软删除，数据一直都在，这里只把标记清掉。
  // 自动运行需要这个回退手段。
  app.post('/api/admin/stations/:slug/restore', c => {
    const { slug } = z.strictObject({ slug: z.string().trim().min(1).max(200) }).parse(c.req.param());
    if (!store.getWithRemoved('station', slug)) throw new ApiError(404, 'NOT_FOUND', '站点不存在');
    if (!store.restore('station', slug)) throw new ApiError(409, 'ALREADY_ONLINE', '该站点当前在线，不需要恢复');
    return c.json({ slug, restored: true });
  });
  app.get('/api/admin/stations/removed', c => {
    const rows = store.db.prepare("SELECT id, removedAt FROM entities WHERE kind = 'station' AND removedAt IS NOT NULL ORDER BY removedAt DESC").all();
    return c.json({ items: rows.map(row => ({ slug: row.id as string, removedAt: row.removedAt as string })) });
  });
  app.post('/api/admin/submissions/:id/review', async c => {
    const decision = submissionReviewSchema.parse(await c.req.json());
    return c.json(reviewSubmission(store, now(), c.req.param('id'), decision));
  });
/**审核顺序要满足物化依赖：站点/模型先过，文章最后。只按调用方给的顺序审，
 *评价会先于站点发布，物化时找不到站点，stationSlug落成 null（实测）。
 *审核台「全部通过」正是按列表顺序传 ids（列表里评价常排在站点前面），
 *所以必须在服务端兜住，不能指望每个调用方自己排。
 */
function orderByMaterializeDependency(store: Store, ids: string[]): string[] {
  const kindOf = new Map<string, string>();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = placeholders.length ===0 ? [] : store.db.prepare(`SELECT id, kind FROM submissions WHERE id IN (${placeholders})`).all(...ids) as { id: string; kind: string }[];
  for (const row of rows) kindOf.set(row.id, row.kind);
  //稳定排序：组内保持调用方给的先后（通常是最新在前）。
  return [...ids].sort((a, b) => Number(kindOf.get(a) === 'post') - Number(kindOf.get(b) === 'post'));
}

  app.post('/api/admin/submissions/batch-review', async c => {
    // ids 保留最多 100 条；batchId 处理整批 pending。每条仍是独立事务。
    const input = submissionBatchReviewSchema.parse(await c.req.json());
    const decision = { status: input.status, reason: input.reason };
    // 排序有两层约束，缺一不可：
    // 1. 依赖顺序——评价文章物化时要靠 hostname 找回站点 slug，站点必须先通过。
    //    单纯倒序会让文章排在站点前面，stationSlug 落成 null（实测）。
    // 2. 同类型内最新优先——同一站点常有多个待审版本，先审旧的会让新版本被
    //    supersedePending 标成 superseded，站点停在旧数据上（界面上看不出来）。
    // 所以按「站点/模型 → 文章」分组，组内 createdAt 倒序。
    const ids = 'ids' in input ? orderByMaterializeDependency(store, input.ids) : store.db.prepare(
      "SELECT id FROM submissions WHERE batchId = ? AND status = 'pending' "
      + "ORDER BY CASE kind WHEN 'post' THEN 1 ELSE 0 END, createdAt DESC, rowid DESC",
    )
      .all(input.batchId).map(row => row.id as string);
    // 只回 {id, status}，不回整条 SubmissionRecord。
    // 500 条时整条记录让响应体到 295KB，而前端只用到「哪些失败、失败原因」；
    // 单条详情本来就有 /api/admin/submissions 可查。
 const results: ({ id: string; status: string; reason: string | null } | { id: string; error: { status: number; code: string; message: string } })[] = [];
    for (const id of ids) {
      // 无论按 ids 还是按 batchId，都跳过「已不是 pending」的行：ids模式下
      // 同站的新旧两版都常在列表里，先审新版会把旧版 supersede掉；这行若照实
      //报 ALREADY_REVIEWED，管理员会看到「N 条未通过」却无从修起——它本来就是
      // 本次审核的正常结果，与 batchId模式一样静默跳过即可。
      const row = store.db.prepare('SELECT status FROM submissions WHERE id = ?').get(id) as { status: string } | undefined;
 //本次运行自己 supersede 的行（pending被前面条目的审核替代）是审核的正常
 //结果，静默跳过；不存在或请求前已是终态的行，说明调用方拿到的是陈旧列表，
 //必须报错让它刷新，静默吞掉会掩盖真实失败。
 if (row?.status === 'superseded') { results.push({ id, status: 'superseded', reason: null }); continue; }
 if (row === undefined) { results.push({ id, error: { status:404, code: 'NOT_FOUND', message: '投稿不存在' } }); continue; }
 if (row.status !== 'pending') { results.push({ id, error: { status:409, code: 'ALREADY_REVIEWED', message: '投稿已审核或被新版本替代' } }); continue; }
      try {
        // reason 一并回：审核员需要知道「为什么被写成这个状态」
        // （例如下架目标不存在时写的是「站点已不存在，视为已下架」）。
        const reviewed = reviewSubmission(store, now(), id, decision);
        results.push({ id, status: reviewed.status, reason: reviewed.reason });
      } catch (error) {
        if (isDatabaseBusyError(error)) throw error;
 if (error instanceof ApiError) results.push({ id, error: { status: error.status, code: error.code, message: error.message, ...error.details } });
        else {
          console.error(error);
          results.push({ id, error: { status: 500, code: 'INTERNAL_ERROR', message: '服务暂时不可用' } });
        }
      }
    }
    return c.json({ results });
  });
  app.get('/api/admin/posts', c => c.json(listPosts(store, postStatus.parse(c.req.query('status')))));
  // 下架 / 恢复已发布的文章。下架是软删除，正文一直留着，误操作能直接撤回。
  app.post('/api/admin/posts/:id/withdraw', c => c.json(withdrawPost(store, c.req.param('id'), now().toISOString())));
  app.post('/api/admin/posts/:id/restore', c => c.json(restorePost(store, c.req.param('id'))));
  app.get('/api/admin/posts/removed', c => {
    const rows = store.db.prepare("SELECT id, removedAt FROM entities WHERE kind = 'post' AND removedAt IS NOT NULL ORDER BY removedAt DESC").all();
    return c.json({ items: rows.map(row => ({ id: row.id as string, removedAt: row.removedAt as string })) });
  });
  app.post('/api/admin/posts/:id/review', async c => {
    const { status } = z.strictObject({ status: postStatus }).parse(await c.req.json());
    return c.json(reviewPost(store, now, c.req.param('id'), status));
  });
  app.post('/api/admin/users/:handle/disable', async c => {
    const { disabled } = z.strictObject({ disabled: z.boolean() }).parse(await c.req.json());
    return c.json(setAccountDisabled(store, c.req.param('handle'), disabled, now()));
  });
  app.post('/api/admin/comments/:id/hide', async c => {
    const { hidden } = z.strictObject({ hidden: z.boolean() }).parse(await c.req.json());
    return c.json(setCommentHidden(store, c.req.param('id'), hidden));
  });

  function route<K extends ApiRouteName>(name: K, schema: z.ZodType<ApiContracts[K]['request']>, handler: (service: Service, input: ApiContracts[K]['request'], ip: string) => ApiContracts[K]['response']) {
    const { method, path } = API_ROUTES[name];
    app.on(method, path, async c => {
      const handle = sessionHandle(store, c.req.header('cookie'), now());
      if (!handle && (method !== 'GET' || PERSONAL_READS.has(name))) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
      const body = method === 'GET' ? '' : await c.req.text();
      // GET 的 query 先归一：丢掉 schema 不认识的键，空串当作没传。
      // 不加这层的话，分享链接带上 utm_source、监控面板带上 _t 这类无关参数就会
      // 被 strictObject 拒成 400，而调用方完全看不出是自己多带了一个参数；
      // `?vendor=` 这种空值同理（前端靠过滤空值绕过去了，外部调用方不会）。
      const raw: unknown = method === 'GET' ? normalizeQuery(schema, { ...c.req.query(), ...c.req.param() }) : JSON.parse(body || '{}');
 //公开读接口的响应体含登录态（currentUserVote/favorited），是按 Cookie变体的：
 //不下 no-store的话，前面一旦加 CDN/代理缓存，A用户的投票状态会被发给 B用户。
 c.header('cache-control', 'no-store');
      return c.json(handler(new Service(store, now, handle), schema.parse(raw), clientIp(c, trustedProxies)));
    });
  }

  function agentRequest(c: AppContext) {
    c.header('cache-control', 'no-store');
    const time = now();
    const authorization = c.req.header('authorization');
    const handle = agentHandle(store, authorization, time);
    return { handle, tokenHash: agentTokenHash(authorization), ip: clientIp(c, trustedProxies), now: time };
  }
  app.post(API_ROUTES.createAgentStation.path, async c => {
    const request = agentRequest(c);
    return c.json(agentApi.submitStation(await c.req.json(), request));
  });
  app.post(API_ROUTES.createAgentPost.path, async c => {
    const request = agentRequest(c);
    return c.json(agentApi.submitPost(await c.req.json(), request));
  });
  app.post(API_ROUTES.createAgentModel.path, async c => {
    const request = agentRequest(c);
    return c.json(agentApi.submitModel(await c.req.json(), request));
  });
  app.get(API_ROUTES.getAgentStatus.path, c => c.json(agentApi.status(agentRequest(c), c.req.query())));

  function refuseIfLimited(c: AppContext, limited: number[]) {
    const retryAfter = Math.max(...limited);
    if (retryAfter === 0) return;
    c.header('retry-after', String(retryAfter));
    throw new ApiError(429, 'RATE_LIMITED', '尝试次数过多，请稍后再试');
  }

  app.post(API_ROUTES.register.path, async c => {
    const input = registerSchema.parse(JSON.parse(await c.req.text() || '{}'));
    if (isWeakPassword(input.password, input.username)) throw new ApiError(400, 'WEAK_PASSWORD', '这个密码太容易被猜到，请换一个（避免常见词、连续字符或包含用户名）');
    const ip = `register:${clientIp(c, trustedProxies)}`;
    const usernameKey = input.username.toLowerCase();
    refuseIfLimited(c, [registerByIp.retryAfter(ip, now().getTime()), registerByUsername.retryAfter(usernameKey, now().getTime())]);
    const registerHandle = registerByIp.record(ip, now().getTime());
    registerByUsername.record(usernameKey, now().getTime());
    const taken = () => store.db.prepare('SELECT 1 FROM accounts WHERE usernameKey = ?').get(usernameKey);
    // 昵称在注册时也要过一遍保留词与重名：只挡「改资料」的话，注册直接填
    // 「管理员」就是一条现成的绕过路径。
    // 顺序有讲究：昵称默认取用户名，先查昵称的话「重复注册同一个用户名」
    // 会先撞成 NICKNAME_TAKEN，把人引向错误的修改方向。
    const wantedNickname = (input.nickname ?? input.username).trim();
    const checkNickname = () => {
      if (isReservedNickname(wantedNickname)) throw new ApiError(400, 'INVALID_INPUT', `「${wantedNickname}」是保留身份，请换一个昵称`);
      // 重名判定用同一个归一函数：否则「管理员」与「管理员\u200B」在库里并存，
      // 界面上看起来是两个一模一样的名字。
      const wantedKey = normalizeNickname(wantedNickname);
      const nicknameTaken = store.all('user').some(user => normalizeNickname(user.nickname) === wantedKey);
      if (nicknameTaken) throw new ApiError(409, 'NICKNAME_TAKEN', '这个昵称已被使用，请换一个');
    };
    if (taken()) throw new ApiError(409, 'USERNAME_TAKEN', '这个用户名无法使用，请换一个');
    checkNickname();
    const passwordHash = await hashPassword(input.password).catch((error: unknown) => {
      registerByIp.release(ip, registerHandle);
      throw error;
    });
    const handle = input.username;
    const token = store.transaction(() => {
      // 哈希期间可能有同名注册抢先。
      if (taken()) throw new ApiError(409, 'USERNAME_TAKEN', '这个用户名无法使用，请换一个');
      // 昵称查重也必须在事务内再确认一次：两人同时用同一昵称注册，
      // 事务外那次检查都会通过。
      checkNickname();
      store.db.prepare('INSERT INTO accounts (handle, usernameKey, passwordHash, createdAt) VALUES (?, ?, ?, ?)').run(handle, usernameKey, passwordHash, now().toISOString());
      store.put('user', handle, { handle, nickname: wantedNickname, avatar: '', bio: '', tokens: INITIAL_TOKENS });
      return createSession(store, handle, now());
    });
    c.header('set-cookie', sessionCookie(token, cookieSecure()));
    return c.json(new Service(store, now, handle).getMe());
  });

  app.post(API_ROUTES.login.path, async c => {
    const input = loginSchema.parse(JSON.parse(await c.req.text() || '{}'));
    const usernameKey = input.username.toLowerCase();
    const ip = `login:${clientIp(c, trustedProxies)}`;
    const pair = `${ip}:${usernameKey}`;
    const time = now().getTime();
    refuseIfLimited(c, [loginByTarget.retryAfter(pair, time), loginByIp.retryAfter(ip, time), loginByUsername.retryAfter(usernameKey, time)]);
    // 在 await 之前同步预占，并发猜测看得到彼此，越不过上限。没失败时再退回。
    const loginTargetHandle = loginByTarget.record(pair, time);
    const loginIpHandle = loginByIp.record(ip, time);
    const loginUsernameHandle = loginByUsername.record(usernameKey, time);
    const refund = () => {
      loginByTarget.release(pair, loginTargetHandle);
      loginByIp.release(ip, loginIpHandle);
      loginByUsername.release(usernameKey, loginUsernameHandle);
    };
    /**
     * 登录成功后的退还策略。
     *
     * 三个都退会让成功登录完全不计入配额：任何注册用户拿自己的正确密码循环打
     * /api/auth/login，就能一直占用密码校验的并发闸门（2 执行 + 16 排队），
     * 把登录、注册、改密一起打成 503，代价只是一个自建账号。所以按账号的
     * loginByUsername **不退**——它防的正是「单人拿自己账号刷」。
     *
     * 按 IP 的 loginByIp 要退：它是按失败次数不该累加的那个维度。办公室、
     * 学校、运营商 CGNAT 后面几十个人共用一个出口 IP，若不退，5 个人各登录
     * 6 次就把 30 次/15 分钟用光，第 31 次起整个 IP 的人都要 429——无论密码对错。
     * 不退那个维度换来的是「同一 IP 的其他人被误伤」，而不退账号维度换来的是
     * 「单人刷自己的账号被挡住」，后者才是我们要防的攻击面。
     */
    const refundOnSuccess = () => {
      loginByTarget.release(pair, loginTargetHandle);
      loginByTarget.clear(pair);
      loginByIp.release(ip, loginIpHandle);
    };
    const account = store.db.prepare('SELECT handle, passwordHash, disabledAt FROM accounts WHERE usernameKey = ?').get(usernameKey);
    let valid: boolean;
    try {
      valid = account ? await verifyPassword(input.password, account.passwordHash as string) : (await burnPasswordCheck(input.password), false);
    } catch (error) {
      refund();
      throw error;
    }
    // 被禁用的账号和密码错误返回同样的错误。
    if (!account || !valid || account.disabledAt !== null) throw new ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
    refundOnSuccess();
    const handle = account.handle as string;
    c.header('set-cookie', sessionCookie(createSession(store, handle, now()), cookieSecure()));
    return c.json(new Service(store, now, handle).getMe());
  });

  app.post(API_ROUTES.changePassword.path, async c => {
    const cookie = c.req.header('cookie');
    const handle = sessionHandle(store, cookie, now());
    if (!handle) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
    const input = changePasswordSchema.parse(JSON.parse(await c.req.text() || '{}'));
    if (isWeakPassword(input.newPassword, handle)) throw new ApiError(400, 'WEAK_PASSWORD', '这个密码太容易被猜到，请换一个（避免常见词、连续字符或包含用户名）');
    const time = now().getTime();
    refuseIfLimited(c, [passwordChangeByUser.retryAfter(handle, time)]);
    passwordChangeByUser.record(handle, time);
    const account = store.db.prepare('SELECT passwordHash FROM accounts WHERE handle = ?').get(handle)!;
    let passwordHash: string;
    try {
      if (!await verifyPassword(input.currentPassword, account.passwordHash as string)) throw new ApiError(400, 'WRONG_PASSWORD', '当前密码不正确');
      passwordHash = await hashPassword(input.newPassword);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'BUSY') passwordChangeByUser.release(handle);
      throw error;
    }
    passwordChangeByUser.clear(handle);
    store.transaction(() => {
      // 条件写：只在这期间密码没被别人改过时才落库。
      // 校验当前密码要等 scrypt（几十毫秒的 await），这中间管理员可能刚重置过密码
      // 或用户自己在另一台设备上改过。无条件的 UPDATE 会把那次结果直接盖掉，
      // 而且两边都返回 200——管理员以为重置生效了，实际登录用的是旧请求写的密码。
      const written = store.db.prepare('UPDATE accounts SET passwordHash = ? WHERE handle = ? AND passwordHash = ?')
        .run(passwordHash, handle, account.passwordHash as string) as { changes?: number };
      if (!written.changes) throw new ApiError(409, 'PASSWORD_CHANGED', '密码刚刚被修改过，请用新密码重新登录后再试');
      deleteOtherSessions(store, handle, cookie);
      // Agent 凭证也要一起吊销。它是长期有效的 bearer token，且没有过期时间；
      // 攻击者盗到会话 cookie 后签发一把，受害者改密码只会清掉会话，
      // 那把凭证仍然能继续提交投稿、占满审核队列。禁用账号时本来就会吊销，
      // 改密码属于同一类「账号被盗后的补救动作」，不能漏。
      store.db.prepare('UPDATE agent_tokens SET revokedAt = ? WHERE handle = ? AND revokedAt IS NULL').run(now().toISOString(), handle);
    });
    return c.json({ ok: true });
  });

  app.post(API_ROUTES.createAgentToken.path, async c => {
    c.header('cache-control', 'no-store');
    const time = now();
    const handle = sessionHandle(store, c.req.header('cookie'), time);
    if (!handle) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
    const input = agentTokenSchema.parse(await c.req.json());
    // 邀请码兑换要同时看「这把码被用过多少次」和「这个尝试者试过几次」，否则
    // 码泄露后可以用它把无限多个新号提权。
    const byUser = `agentToken:${handle}`;
    const byIp = `agentTokenIp:${clientIp(c, trustedProxies)}`;
    refuseIfLimited(c, [agentTokenByUser.retryAfter(byUser, time.getTime()), agentTokenByIp.retryAfter(byIp, time.getTime()),
      ...(input.inviteCode === undefined ? [] : [inviteByCode.retryAfter(`invite:${input.inviteCode}`, time.getTime())])]);
    const userHandle = agentTokenByUser.record(byUser, time.getTime());
    const ipHandle = agentTokenByIp.record(byIp, time.getTime());
    const inviteHandle = input.inviteCode === undefined ? undefined : inviteByCode.record(`invite:${input.inviteCode}`, time.getTime());
    try {
      return c.json(createAgentToken(store, { ...input, handle, now: time, inviteCodes: options.inviteCodes }));
    } catch (error) {
      // 准入没通过且**没填邀请码**时退回计数：那多半是注册不满 7 天的合法用户在等，
      // 不该把失败尝试算进配额。带码失败（无效/过期/用尽/吊销）正是要限的滥用路径，
      // 退回等于把该接口的限流整个取消——无脑填错码就能无限打。
      // TOKEN_LIMIT 与路径无关，退回无副作用。
      if (error instanceof ApiError && (error.code === 'TOKEN_LIMIT' || (error.code === 'ELIGIBILITY_REQUIRED' && input.inviteCode === undefined))) {
        agentTokenByUser.release(byUser, userHandle);
        agentTokenByIp.release(byIp, ipHandle);
        if (input.inviteCode !== undefined) inviteByCode.release(`invite:${input.inviteCode}`, inviteHandle);
      }
      throw error;
    }
  });
  app.get(API_ROUTES.getAgentTokens.path, c => {
    c.header('cache-control', 'no-store');
    const handle = sessionHandle(store, c.req.header('cookie'), now());
    if (!handle) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
    return c.json(listAgentTokens(store, handle));
  });
  app.delete(API_ROUTES.revokeAgentToken.path, c => {
    c.header('cache-control', 'no-store');
    const time = now();
    const handle = sessionHandle(store, c.req.header('cookie'), time);
    if (!handle) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
    return c.json(revokeAgentToken(store, handle, identifier.parse(c.req.param('id')), time));
  });

  app.post(API_ROUTES.logout.path, c => {
    deleteSession(store, c.req.header('cookie'));
    c.header('set-cookie', clearedSessionCookie(cookieSecure()));
    return c.json({ ok: true });
  });

  route('getMe', z.strictObject({}), service => service.getMe());
  route('updateMe', z.strictObject({ nickname: nickname.optional(), bio: z.string().trim().max(PROFILE_LIMITS.bio).optional() }).refine(input => Object.keys(input).length > 0), (service, input) => service.updateMe(input));
  route('checkIn', z.strictObject({}), service => {
    // 没限流时脚本可以循环打点；虽然一天只成功一次，
    // 但每次都要走一遍事务和写库，足以把库压住。
    const key = service.handle ?? '';
    const wait = checkInByUser.retryAfter(key, now().getTime());
    if (wait > 0) throw new ApiError(429, 'RATE_LIMITED', '签到太频繁了，请稍后再试', { retryAfter: wait });
    checkInByUser.record(key, now().getTime());
    return service.checkIn();
  });
  route('getMyFavorites', z.strictObject(pagination), (service, input) => service.getMyFavorites(input));
  route('getMyPosts', z.strictObject(pagination), (service, input) => service.getMyPosts(input));
  route('getVendors', z.strictObject(pagination), (service, input) => service.getVendors(input));
  route('getModels', z.strictObject({ ...pagination, vendor: identifier.optional(), q: queryText }), (service, input) => service.getModels(input));
  route('getModel', z.strictObject({ slug: identifier }), (service, input) => service.getModel(input.slug));
  route('getStations', z.strictObject({ ...pagination, vendor: identifier.optional(), q: queryText, sort: z.enum(['score', 'rate', 'uptime']).optional() }), (service, input) => service.getStations(input));
  route('getStation', z.strictObject({ slug: identifier }), (service, input) => service.getStation(input.slug));
  route('getPosts', z.strictObject({ ...pagination, kind: kind.optional(), vendor: identifier.optional(), station: identifier.optional(), model: identifier.optional(), sort: z.enum(['latest', 'hot']).optional(), q: queryText }), (service, input) => service.getPosts(input));
  route('getPost', z.strictObject({ id: identifier }), (service, input) => service.getPost(input.id));
  route('createPost', z.strictObject({ kind, title: z.string().trim().min(1).max(200), summary: z.string().trim().min(1).max(1000), body: z.string().min(1).max(100_000).refine(body => body.trim().length > 0), stationSlug: identifier.optional(), modelSlug: identifier.optional() }), (service, input, ip) => {
    // 站内发帖也进统一队列：飞书和 Agent 都走 submission，只有站内另写 entities，
    // 管理员就得在两个地方看待审。内容来源标成「用户投稿」。
    service.assertCanSubmitPost();
    if (input.stationSlug && !store.get('station', input.stationSlug)) throw new ApiError(400, 'INVALID_INPUT', '关联中转站不存在');
    if (input.modelSlug && !store.get('model', input.modelSlug)) throw new ApiError(400, 'INVALID_INPUT', '关联模型不存在');
    const payload = {
      kind: input.kind, title: input.title, summary: input.summary, body: input.body,
      stationSlug: input.stationSlug ?? null, modelSlug: input.modelSlug ?? null,
    };
    const originKey = `web:${service.handle}:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
    const result = enqueueSubmission(store, {
      kind: 'post', channel: 'web', originKey, payload, actorHandle: service.handle, ip, now: now(),
    });
    return service.pendingPost(result.submission);
  });
  // 站内补录模型：规划 4.2 承诺过这条通道，此前只实现了物化侧，
  // 模型只能由管理员直接建。走 web 渠道进同一个队列，和其他投稿一样需要审核。
  route('suggestModel', modelSchema.strict(), (service, input, ip) => {
    service.assertCanSubmitPost();
    const payload = { slug: input.slug, vendor: input.vendor, name: input.name, description: input.description };
    if (!store.get('vendor', payload.vendor)) throw new ApiError(400, 'INVALID_INPUT', `厂商不存在：${payload.vendor}`);
    if (store.get('model', payload.slug)) throw new ApiError(409, 'MODEL_EXISTS', `模型 ${payload.slug} 已存在`);
    const originKey = `web:${service.handle}:model:${payload.slug}`;
    const result = enqueueSubmission(store, {
      kind: 'model', channel: 'web', originKey, payload, actorHandle: service.handle, ip, now: now(),
    });
    return { id: result.submission.id, slug: payload.slug, status: result.submission.status, deduplicated: result.deduplicated };
  });
  // 站内推荐新中转站。此前用户只能写文章或补录模型，站点供给完全靠飞书和 Agent，
  // 读者看到没收录的站无处可提。走 web 渠道进同一个队列，审核后由同一套
  // materialize 建站，和其他投稿没有两样。
  route('suggestStation', z.strictObject({
    name: z.string().trim().min(1).max(60),
    url: z.string().trim().min(1).max(300),
    description: z.string().trim().max(300).optional(),
    // 报价可以留空：推荐人未必知道倍率，管理员审核时补。
    // basis 允许不给（沿用综合倍率），但给了就必须是四种口径之一——
    // 让用户随手写个「输入」以外的自由文本，等于把口径变成没人能比的字符串。
    offers: z.array(z.strictObject({
      modelSlug: z.string().trim().min(1).max(200),
      // 倍率范围与投稿契约同一套常量：放行 99999 会让这条推荐通过校验、
      // 却在物化时被 stationSchema 拒掉，整条记录停在 pending 等人工发现。
      rate: z.number().min(MIN_RATE).max(MAX_RATE),
      basis: rateBasis.optional(),
      quotedAt: z.iso.datetime({ offset: true }).nullish(),
    })).max(100).optional(),
    rechargeThreshold: z.number().min(0).nullable().optional(),
    paymentMethods: z.array(z.string().trim().min(1).max(20)).max(10).optional(),
  }), (service, input, ip) => {
    service.assertCanSubmitPost();
    // stationSchema 要求字段齐全，而推荐人是「知道多少填多少」，这里补默认值。
    // 名称是必填项，描述可留空——审核时再补。
    const payload = {
      name: input.name,
      description: input.description?.trim() || '待补充',
      url: input.url,
      rechargeThreshold: input.rechargeThreshold ?? null,
      paymentMethods: input.paymentMethods ?? [],
      offers: input.offers ?? [],
    };
    // 报价里的模型必须真实存在：物化时未知模型会抛 400 让整条记录停在 pending，
    // 不如在提交时就报清楚，推荐人才知道是模型名写错了。
    for (const offer of payload.offers) {
      if (!store.get('model', offer.modelSlug)) throw new ApiError(400, 'INVALID_INPUT', `未知模型：${offer.modelSlug}`);
    }
    // url 的合法性（http/https、非内网、不带 query）由 enqueueSubmission 里的
    // stationSchema 校验兜住，这里不重复实现一套规则。
    const originKey = `web:${service.handle}:station:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
    const result = enqueueSubmission(store, {
      kind: 'station', channel: 'web', originKey, payload, actorHandle: service.handle, ip, now: now(),
    });
    return { id: result.submission.id, status: result.submission.status, deduplicated: result.deduplicated };
  });
  route('getMySubmissions', z.strictObject(pagination), (service, input) => service.getMySubmissions(input));
 //投票与收藏共用同一道滑窗（429语义与签到一致）：两者都是登录后的
 //高频可重复写，不设闸时同一会话每秒能打几百次全表扫描式写事务。
 const voteGuard = (service: { handle: string | null }): void => {
 const key = service.handle ?? '';
 const wait = voteByUser.retryAfter(key, now().getTime());
 if (wait > 0) throw new ApiError(429, 'RATE_LIMITED', '操作太频繁了，请稍后再试', { retryAfter: wait });
 voteByUser.record(key, now().getTime());
 };
 route('putVote', z.strictObject({ ...target, value: z.enum(['up', 'down']).nullable() }), (service, input) => { voteGuard(service); return service.putVote(input); });
 route('putFavorite', z.strictObject({ ...target, favorited: z.boolean() }), (service, input) => { voteGuard(service); return service.putFavorite(input); });
  route('getComments', z.strictObject({ ...pagination, ...target }), (service, input) => service.getComments(input));
  route('createComment', z.strictObject({ ...target, content: z.string().trim().min(1).max(2000), parentId: identifier.optional() }), (service, input) => service.createComment(input));
  route('getRankings', z.strictObject({ ...pagination, tab: z.enum(['model', 'community', 'expert']) }), (service, input) => service.getRankings(input));
  route('getBanners', z.strictObject(pagination), (service, input) => service.getBanners(input));
  route('search', z.strictObject({ q: z.string().trim().max(200) }), (service, input) => service.search(input.q));
  route('getHotSearches', z.strictObject(pagination), (service, input) => service.getHotSearches(input));
  return app;
}
