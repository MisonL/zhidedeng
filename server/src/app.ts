import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';
import { API_ROUTES } from '@zhidedeng/shared';
import type { ApiContracts, ApiRouteName, ChangePasswordRequest, LoginRequest, RegisterRequest } from '@zhidedeng/shared';
import { AttemptLimiter, burnPasswordCheck, clearedSessionCookie, createSession, deleteOtherSessions, deleteSession, hashPassword, INITIAL_TOKENS, isWeakPassword, sessionCookie, sessionHandle, USERNAME, verifyPassword } from './auth.ts';
import { agentTokenSchema, createAgentToken, listAgentTokens, revokeAgentToken } from './agent-tokens.ts';
import { authorizeAdmin, adminSlug, createModel, createVendor, deleteModel, importResponse, updateModel } from './catalog.ts';
import type { Store } from './database.ts';
import { Service } from './service.ts';
import { ApiError, isDatabaseBusyError } from './errors.ts';
import { listPosts, reviewPost, setAccountDisabled, setCommentHidden } from './moderation.ts';
import { autoApproveEnabled, enqueueBatch, enqueueSubmission, listSubmissions, reviewSubmission, setAutoApprove, submissionBatchReviewSchema, submissionBatchSchema, submissionQuerySchema, submissionReviewSchema, submissionState } from './submissions.ts';

const pagination = {
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  pageSize: z.coerce.number().int().min(1).transform(size => Math.min(size, 50)).optional(),
};
const queryText = z.string().trim().max(200).optional();
const identifier = z.string().trim().min(1).max(200);
const target = { targetType: z.enum(['post', 'station']), targetId: identifier };
const kind = z.enum(['deal', 'review', 'community', 'guide']);
const nickname = z.string().trim().min(1).max(20);
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
}

interface Bindings {
  incoming?: { socket: { remoteAddress?: string } };
}
type AppContext = Context<{ Bindings: Bindings }>;

/** 限流键。IPv6 用户通常握有整个 /64，按单个地址计数等于没限。 */
export function normalizeIp(ip: string) {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const address = ip.toLowerCase().split('%')[0];
  const [head, tail] = address.split('::');
  const leading = head ? head.split(':') : [];
  const trailing = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...leading, ...Array<string>(8 - leading.length - trailing.length).fill('0'), ...trailing] : leading;
  return `${groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** 只监听本机，直连方是 nginx 时才信任它写入的 X-Forwarded-For；其他情况用直连地址。 */
function clientIp(c: AppContext) {
  const remote = c.env?.incoming?.socket.remoteAddress;
  const fromProxy = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return normalizeIp((fromProxy ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined) ?? remote ?? 'unknown');
}

export function buildApp(store: Store, now: () => Date, options: AppOptions = {}) {
  const secure = options.secureCookie ?? false;
  const loginByTarget = new AttemptLimiter(5, LOGIN_WINDOW_MS);
  const loginByIp = new AttemptLimiter(30, LOGIN_WINDOW_MS);
  // 不随 IP 变化：防多个 IP 轮流猜同一账号。代价是别人可以把某个账号暂时挡在登录外。
  const loginByUsername = new AttemptLimiter(20, LOGIN_WINDOW_MS);
  const passwordChangeByUser = new AttemptLimiter(5, LOGIN_WINDOW_MS);
  const registerByIp = new AttemptLimiter(10, REGISTER_WINDOW_MS);
  const inviteByCode = new AttemptLimiter(INVITE_PER_CODE_LIMIT, INVITE_WINDOW_MS);
  const agentTokenByUser = new AttemptLimiter(AGENT_TOKEN_PER_USER, AGENT_TOKEN_WINDOW_MS);
  const agentTokenByIp = new AttemptLimiter(AGENT_TOKEN_PER_IP, AGENT_TOKEN_WINDOW_MS);

  const app = new Hono<{ Bindings: Bindings }>();
  app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: '资源不存在' } }, 404));
  app.onError((error, c) => {
    if (isDatabaseBusyError(error)) return c.json({ error: { code: 'BUSY', message: '数据库繁忙，请重试' } }, 503);
    if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message, ...error.details } }, error.status);
    if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: { code: 'INVALID_INPUT', message: '请求参数或 JSON 正文无效' } }, 400);
    console.error(error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' } }, 500);
  });

  // 跨站表单发不出 application/json，配合 SameSite=Lax 防 CSRF。
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !/^application\/json\b/i.test(c.req.header('content-type') ?? '')) {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '写接口要求 Content-Type: application/json');
    }
    await next();
  });

  const tooLarge = () => { throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体过大'); };
  const apiBodyLimit = bodyLimit({ maxSize: API_BODY_BYTES, onError: tooLarge });
  const importBodyLimit = bodyLimit({ maxSize: IMPORT_BODY_BYTES, onError: tooLarge });
  app.use('/api/*', (c, next) => ([IMPORT_PATH, SUBMISSION_BATCH_PATH].includes(c.req.path) ? importBodyLimit : apiBodyLimit)(c, next));

  app.get('/api/health', c => {
    store.db.prepare('SELECT 1').get();
    return c.json({ status: 'ok' });
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
    return c.json(enqueueSubmission(store, { ...input, ip: clientIp(c), now: now() }));
  });
  app.post(SUBMISSION_BATCH_PATH, async c => {
    const input = submissionBatchSchema.parse(await c.req.json());
    return c.json(enqueueBatch(store, { ...input, ip: clientIp(c), now: now() }));
  });
  app.get('/api/admin/submissions/state', c => c.json(submissionState(store)));
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
  app.post('/api/admin/submissions/batch-review', async c => {
    // ids 保留最多 100 条；batchId 处理整批 pending。每条仍是独立事务。
    const input = submissionBatchReviewSchema.parse(await c.req.json());
    const decision = { status: input.status, reason: input.reason };
    const ids = 'ids' in input ? input.ids : store.db.prepare("SELECT id FROM submissions WHERE batchId = ? AND status = 'pending' ORDER BY createdAt, rowid")
      .all(input.batchId).map(row => row.id as string);
    const results: ({ id: string; submission: ReturnType<typeof reviewSubmission> } | { id: string; error: { status: number; code: string; message: string } })[] = [];
    for (const id of ids) {
      // 同批次的其他版本可能刚被前一条审核替代，这些已经不是待审条目。
      if ('batchId' in input && store.db.prepare('SELECT status FROM submissions WHERE id = ?').get(id)?.status !== 'pending') continue;
      try {
        results.push({ id, submission: reviewSubmission(store, now(), id, decision) });
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
  app.post('/api/admin/posts/:id/review', async c => {
    const { status } = z.strictObject({ status: postStatus }).parse(await c.req.json());
    return c.json(reviewPost(store, c.req.param('id'), status));
  });
  app.post('/api/admin/users/:handle/disable', async c => {
    const { disabled } = z.strictObject({ disabled: z.boolean() }).parse(await c.req.json());
    return c.json(setAccountDisabled(store, c.req.param('handle'), disabled, now()));
  });
  app.post('/api/admin/comments/:id/hide', async c => {
    const { hidden } = z.strictObject({ hidden: z.boolean() }).parse(await c.req.json());
    return c.json(setCommentHidden(store, c.req.param('id'), hidden));
  });

  function route<K extends ApiRouteName>(name: K, schema: z.ZodType<ApiContracts[K]['request']>, handler: (service: Service, input: ApiContracts[K]['request']) => ApiContracts[K]['response']) {
    const { method, path } = API_ROUTES[name];
    app.on(method, path, async c => {
      const handle = sessionHandle(store, c.req.header('cookie'), now());
      if (!handle && (method !== 'GET' || PERSONAL_READS.has(name))) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
      const body = method === 'GET' ? '' : await c.req.text();
      const raw: unknown = method === 'GET' ? { ...c.req.query(), ...c.req.param() } : JSON.parse(body || '{}');
      return c.json(handler(new Service(store, now, handle), schema.parse(raw)));
    });
  }

  function refuseIfLimited(c: AppContext, limited: number[]) {
    const retryAfter = Math.max(...limited);
    if (retryAfter === 0) return;
    c.header('retry-after', String(retryAfter));
    throw new ApiError(429, 'RATE_LIMITED', '尝试次数过多，请稍后再试');
  }

  app.post(API_ROUTES.register.path, async c => {
    const input = registerSchema.parse(JSON.parse(await c.req.text() || '{}'));
    if (isWeakPassword(input.password)) throw new ApiError(400, 'WEAK_PASSWORD', '这个密码太常见了，请换一个');
    const ip = `register:${clientIp(c)}`;
    refuseIfLimited(c, [registerByIp.retryAfter(ip, now().getTime())]);
    registerByIp.record(ip, now().getTime());
    const usernameKey = input.username.toLowerCase();
    const taken = () => store.db.prepare('SELECT 1 FROM accounts WHERE usernameKey = ?').get(usernameKey);
    if (taken()) throw new ApiError(409, 'USERNAME_TAKEN', '这个用户名已被注册');
    const passwordHash = await hashPassword(input.password).catch((error: unknown) => {
      registerByIp.release(ip);
      throw error;
    });
    const handle = input.username;
    const token = store.transaction(() => {
      // 哈希期间可能有同名注册抢先。
      if (taken()) throw new ApiError(409, 'USERNAME_TAKEN', '这个用户名已被注册');
      store.db.prepare('INSERT INTO accounts (handle, usernameKey, passwordHash, createdAt) VALUES (?, ?, ?, ?)').run(handle, usernameKey, passwordHash, now().toISOString());
      store.put('user', handle, { handle, nickname: input.nickname ?? input.username, avatar: '', bio: '', tokens: INITIAL_TOKENS });
      return createSession(store, handle, now());
    });
    c.header('set-cookie', sessionCookie(token, secure));
    return c.json(new Service(store, now, handle).getMe());
  });

  app.post(API_ROUTES.login.path, async c => {
    const input = loginSchema.parse(JSON.parse(await c.req.text() || '{}'));
    const usernameKey = input.username.toLowerCase();
    const ip = `login:${clientIp(c)}`;
    const pair = `${ip}:${usernameKey}`;
    const time = now().getTime();
    refuseIfLimited(c, [loginByTarget.retryAfter(pair, time), loginByIp.retryAfter(ip, time), loginByUsername.retryAfter(usernameKey, time)]);
    // 在 await 之前同步预占，并发猜测看得到彼此，越不过上限。没失败时再退回。
    loginByTarget.record(pair, time);
    loginByIp.record(ip, time);
    loginByUsername.record(usernameKey, time);
    const refund = () => {
      loginByTarget.release(pair);
      loginByIp.release(ip);
      loginByUsername.release(usernameKey);
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
    refund();
    loginByTarget.clear(pair);
    const handle = account.handle as string;
    c.header('set-cookie', sessionCookie(createSession(store, handle, now()), secure));
    return c.json(new Service(store, now, handle).getMe());
  });

  app.post(API_ROUTES.changePassword.path, async c => {
    const cookie = c.req.header('cookie');
    const handle = sessionHandle(store, cookie, now());
    if (!handle) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
    const input = changePasswordSchema.parse(JSON.parse(await c.req.text() || '{}'));
    if (isWeakPassword(input.newPassword)) throw new ApiError(400, 'WEAK_PASSWORD', '这个密码太常见了，请换一个');
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
      store.db.prepare('UPDATE accounts SET passwordHash = ? WHERE handle = ?').run(passwordHash, handle);
      deleteOtherSessions(store, handle, cookie);
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
    const byIp = `agentTokenIp:${clientIp(c)}`;
    refuseIfLimited(c, [agentTokenByUser.retryAfter(byUser, time.getTime()), agentTokenByIp.retryAfter(byIp, time.getTime()),
      ...(input.inviteCode === undefined ? [] : [inviteByCode.retryAfter(`invite:${input.inviteCode}`, time.getTime())])]);
    agentTokenByUser.record(byUser, time.getTime());
    agentTokenByIp.record(byIp, time.getTime());
    if (input.inviteCode !== undefined) inviteByCode.record(`invite:${input.inviteCode}`, time.getTime());
    try {
      return c.json(createAgentToken(store, { ...input, handle, now: time, inviteCodes: options.inviteCodes }));
    } catch (error) {
      // 准入没通过就退回计数，避免失败尝试把合法用户挡在门外。
      if (error instanceof ApiError && (error.code === 'ELIGIBILITY_REQUIRED' || error.code === 'TOKEN_LIMIT')) {
        agentTokenByUser.release(byUser);
        agentTokenByIp.release(byIp);
        if (input.inviteCode !== undefined) inviteByCode.release(`invite:${input.inviteCode}`);
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
    c.header('set-cookie', clearedSessionCookie(secure));
    return c.json({ ok: true });
  });

  route('getMe', z.strictObject({}), service => service.getMe());
  route('updateMe', z.strictObject({ nickname: nickname.optional(), bio: z.string().trim().max(500).optional() }).refine(input => Object.keys(input).length > 0), (service, input) => service.updateMe(input));
  route('checkIn', z.strictObject({}), service => service.checkIn());
  route('getMyFavorites', z.strictObject(pagination), (service, input) => service.getMyFavorites(input));
  route('getMyPosts', z.strictObject(pagination), (service, input) => service.getMyPosts(input));
  route('getVendors', z.strictObject(pagination), (service, input) => service.getVendors(input));
  route('getModels', z.strictObject({ ...pagination, vendor: identifier.optional(), q: queryText }), (service, input) => service.getModels(input));
  route('getModel', z.strictObject({ slug: identifier }), (service, input) => service.getModel(input.slug));
  route('getStations', z.strictObject({ ...pagination, vendor: identifier.optional(), q: queryText, sort: z.enum(['score', 'rate', 'uptime']).optional() }), (service, input) => service.getStations(input));
  route('getStation', z.strictObject({ slug: identifier }), (service, input) => service.getStation(input.slug));
  route('getPosts', z.strictObject({ ...pagination, kind: kind.optional(), vendor: identifier.optional(), station: identifier.optional(), model: identifier.optional(), sort: z.enum(['latest', 'hot']).optional(), q: queryText }), (service, input) => service.getPosts(input));
  route('getPost', z.strictObject({ id: identifier }), (service, input) => service.getPost(input.id));
  route('createPost', z.strictObject({ kind, title: z.string().trim().min(1).max(200), summary: z.string().trim().min(1).max(1000), body: z.string().min(1).max(100_000).refine(body => body.trim().length > 0), stationSlug: identifier.optional(), modelSlug: identifier.optional() }), (service, input) => service.createPost(input));
  route('putVote', z.strictObject({ ...target, value: z.enum(['up', 'down']).nullable() }), (service, input) => service.putVote(input));
  route('putFavorite', z.strictObject({ ...target, favorited: z.boolean() }), (service, input) => service.putFavorite(input));
  route('getComments', z.strictObject({ ...pagination, ...target }), (service, input) => service.getComments(input));
  route('createComment', z.strictObject({ ...target, content: z.string().trim().min(1).max(2000), parentId: identifier.optional() }), (service, input) => service.createComment(input));
  route('getRankings', z.strictObject({ ...pagination, tab: z.enum(['model', 'community', 'expert']) }), (service, input) => service.getRankings(input));
  route('getBanners', z.strictObject(pagination), (service, input) => service.getBanners(input));
  route('search', z.strictObject({ q: z.string().trim().max(200) }), (service, input) => service.search(input.q));
  route('getHotSearches', z.strictObject(pagination), (service, input) => service.getHotSearches(input));
  return app;
}
