#!/usr/bin/env node
/**
 * zdd —— 「什么值得蹬」的 Agent 命令行工具。
 *
 * 设计要点：
 * - stdout 只输出 JSON，人类可读的提示一律走 stderr，方便 Agent 直接管道解析。
 * - 校验规则从 @zhidedeng/shared 导入，与服务端共用同一份 schema，避免本地通过、服务端拒绝。
 * - 退出码固定，Agent 据此判断该重试、该改数据，还是该重新登录。
 */
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { API_ROUTES, type AgentSubmitResponse, type GetAgentStatusResponse } from '@zhidedeng/shared';
import { agentModelSchema, agentPostSchema, agentStationSchema, findForbiddenAgentField } from '@zhidedeng/shared/submission';

export const EXIT = {
  ok: 0,
  usage: 1,
  network: 2,
  validation: 3,
  rejected: 4,
  unauthorized: 5,
} as const;

const DEFAULT_BASE = 'https://zhidedeng.856685.xyz';

/** 退出码对应的可重试建议，写给 Agent 看。 */
const NEXT_ACTION: Record<number, string> = {
  [EXIT.ok]: '成功',
  [EXIT.usage]: '命令用法有误，检查参数后重试',
  [EXIT.network]: '网络或服务端问题，可以稍后原样重试',
  [EXIT.validation]: '本地校验未通过，按 issues 修正数据后重试，不要原样重试',
  [EXIT.rejected]: '服务端拒绝，按 message 修正后再试；配额类错误需要等待',
  [EXIT.unauthorized]: '先运行 zdd login --key <凭证>；若提示凭证无效，请让账号持有人重新签发',
};

/** CLI 自身抛出的、带退出码的错误。 */
export class ZdError extends Error {
  // 不用 TS 参数属性：node --experimental-strip-types 的 strip-only 模式不支持，会直接崩。
  readonly code: number;
  readonly detail: unknown;

  constructor(code: number, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

interface Config {
  apiBase: string;
  token: string;
}

/** 配置文件位置。测试通过 ZDD_CONFIG_HOME 改写，避免污染真实 HOME。 */
export function configPath(): string {
  const base = process.env.ZDD_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'zdd', 'config.json');
}

export function apiBase(): string {
  return (process.env.ZDD_API_BASE ?? DEFAULT_BASE).replace(/\/+$/, '');
}

/** 请求实际使用的地址：环境变量优先于登录时记住的地址。 */
export async function resolveBase(path = configPath()): Promise<string> {
  if (process.env.ZDD_API_BASE) return apiBase();
  const config = await readConfig(path);
  return config ? config.apiBase.replace(/\/+$/, '') : DEFAULT_BASE;
}

export async function readConfig(path = configPath()): Promise<Config | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    if (typeof parsed.token !== 'string' || parsed.token.length === 0) return null;
    return { apiBase: typeof parsed.apiBase === 'string' ? parsed.apiBase : apiBase(), token: parsed.token };
  } catch {
    return null;
  }
}

/** 权限收紧到本人可读写；目录同理。Windows 上 chmod 是空操作，不报错。 */
export async function writeConfig(config: Config, path = configPath()): Promise<void> {
  const dir = dirname(path);
  // 目录先收紧。已存在的目录 mkdir 不会改权限，所以要单独 chmod。
  // 收不紧就中止：宽权限目录里的 0600 文件仍然可被替换。
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch (error) {
    throw new ZdError(EXIT.network, `配置目录收不紧权限（${error instanceof Error ? error.message : String(error)}），已中止`);
  }

  // 秘密不能先落到宽权限文件上再修：writeFile 的 mode 只在新创建时生效，
  // 已存在的 0666 文件会带着旧权限写入，中间存在可被其他用户读到的窗口。
  // 改成「同目录临时文件（0600 从创建那一刻生效）→ 写满 → 校验 → rename」。
  const temp = join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600);
    // 替换之前先确认临时文件确实是私有的。这里失败不会动到既有配置。
    const tempMode = (await stat(temp)).mode & 0o777;
    if (tempMode !== 0o600) {
      throw new ZdError(EXIT.network, `临时凭证文件权限是 ${tempMode.toString(8)}，不是 600，已放弃写入`);
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    if (error instanceof ZdError) throw error;
    throw new ZdError(EXIT.network, `保存凭证失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 解析出的凭证：环境变量优先，便于 CI 不用写盘。 */
export async function resolveToken(path = configPath()): Promise<string> {
  const fromEnv = process.env.ZDD_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const config = await readConfig(path);
  if (!config) throw new ZdError(EXIT.unauthorized, '还没有登录，请先运行 zdd login --key <凭证>');
  return config.token;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  token?: string;
  base?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** 统一发请求并把各种失败映射成带退出码的 ZdError。 */
export async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
  const { method = 'GET', body, token, base, fetchImpl = fetch, timeoutMs = 20_000 } = options;
  // 优先级：显式传入 > 环境变量 > 配置文件里记住的地址 > 线上默认。
  const target = (base ?? (await resolveBase())).replace(/\/+$/, '');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetchImpl(`${target}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ZdError(EXIT.network, `请求失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    // 与下面 JSON 分支保持同一套分类：先看状态码，再看正文格式。
    const code = response.status === 401 || response.status === 403 ? EXIT.unauthorized
      : response.ok || response.status >= 500 ? EXIT.network
        : EXIT.rejected;
    throw new ZdError(code, `服务端返回了非 JSON 响应（HTTP ${response.status}）`);
  }

  if (response.ok) return payload;
  const message = (payload as { error?: { message?: string } })?.error?.message ?? `HTTP ${response.status}`;
  if (response.status === 401 || response.status === 403) throw new ZdError(EXIT.unauthorized, message);
  // 5xx 是服务端故障，无论响应正文是什么格式都要可原样重试；
  // 早先按正文是否 JSON 分类，导致同类故障被引导去改投稿数据。
  if (response.status >= 500) throw new ZdError(EXIT.network, message);
  throw new ZdError(EXIT.rejected, message, payload);
}

/* ------------------------------------------------------------------ login */

export async function login(key: string, options: { fetchImpl?: typeof fetch } = {}): Promise<{ handle: string; savedTo: string }> {
  const token = key.trim();
  if (!/^zd_[A-Za-z0-9_-]{16,}$/.test(token)) {
    throw new ZdError(EXIT.validation, '凭证格式不对，应以 zd_ 开头');
  }
  // 验证和落盘必须用同一个地址。早先验证走 resolveBase()（会读配置），
  // 落盘却用 apiBase()（只看环境变量），于是在自定义地址上重新登录一次，
  // 配置就被改写成线上默认地址，下一次请求带着凭证打到生产站点。
  const path = configPath();
  const base = await resolveBase(path);
  const status = await request(API_ROUTES.getAgentStatus.path, {
    token, base, fetchImpl: options.fetchImpl,
  }) as GetAgentStatusResponse;
  await writeConfig({ apiBase: base, token }, path);
  return { handle: status.handle, savedTo: path };
}

/* ----------------------------------------------------------------- whoami */

export async function whoami(options: { token?: string; fetchImpl?: typeof fetch } = {}): Promise<GetAgentStatusResponse & { apiBase: string }> {
  const token = options.token ?? (await resolveToken());
  const status = await request(API_ROUTES.getAgentStatus.path, { token, fetchImpl: options.fetchImpl }) as GetAgentStatusResponse;
  return { ...status, apiBase: await resolveBase() };
}

/* ---------------------------------------------------------------- catalog */

export interface Catalog {
  vendors: unknown[];
  models: { slug: string; name: string; vendor: string }[];
  stations: { slug: string; name: string; url: string }[];
}

/** 分页接口最多 50 条一页，翻到 total 取完为止。页数设上限防止服务端异常时死循环。 */
async function fetchAllPages(path: string, fetchImpl?: typeof fetch): Promise<unknown> {
  const pageSize = 50;
  const collected: unknown[] = [];
  for (let page = 1; page <= 40; page++) {
    const payload = await request(`${path}?page=${page}&pageSize=${pageSize}`, { fetchImpl }) as { items?: unknown; total?: unknown };
    const items = Array.isArray(payload?.items) ? payload.items : [];
    collected.push(...items);
    const total = typeof payload?.total === 'number' ? payload.total : items.length;
    if (items.length < pageSize || collected.length >= total) break;
  }
  return collected;
}

export async function catalog(options: { fetchImpl?: typeof fetch } = {}): Promise<Catalog> {
  const [vendors, models, stations] = await Promise.all([
    request(API_ROUTES.getVendors.path, { fetchImpl: options.fetchImpl }),
    // 模型和站点会超过一页，只取首页会让 match 看不到已有模型。
    fetchAllPages(API_ROUTES.getModels.path, options.fetchImpl),
    fetchAllPages(API_ROUTES.getStations.path, options.fetchImpl),
  ]);
  // 服务端分页接口直接返回 {items,total,page,pageSize}，没有外层包裹；
  // 少数接口返回裸数组。两种都认，但不猜别的形状——猜错会静默返回空。
  const list = (payload: unknown): unknown[] => {
    if (Array.isArray(payload)) return payload;
    const items = (payload as { items?: unknown })?.items;
    return Array.isArray(items) ? items : [];
  };
  return {
    vendors: list(vendors),
    models: list(models) as Catalog['models'],
    stations: list(stations) as Catalog['stations'],
  };
}

/* ------------------------------------------------------------------ match */

/** 归一化模型名：忽略大小写、空格、连字符、下划线、点号。 */
export function normalizeModelName(value: string): string {
  return value.toLowerCase().replace(/[\s\-_.]+/g, '');
}

export interface MatchResult {
  query: string;
  matches: { slug: string; name: string; vendor: string }[];
  suggestion: string | null;
}

export function matchModel(query: string, models: { slug: string; name: string; vendor: string }[]): MatchResult {
  const trimmed = query.trim();
  const slugExact = models.filter(model => model.slug === trimmed.toLowerCase());
  if (slugExact.length === 1) return { query: trimmed, matches: slugExact, suggestion: null };

  const nameExact = models.filter(model => model.name.toLowerCase() === trimmed.toLowerCase());
  if (nameExact.length === 1) return { query: trimmed, matches: nameExact, suggestion: null };

  const normalized = normalizeModelName(trimmed);
  if (normalized.length > 0) {
    const fuzzy = models.filter(model => normalizeModelName(model.slug) === normalized || normalizeModelName(model.name) === normalized);
    if (fuzzy.length > 0) return { query: trimmed, matches: fuzzy, suggestion: null };
    const partial = models.filter(model => normalizeModelName(model.name).includes(normalized) || normalizeModelName(model.slug).includes(normalized));
    if (partial.length > 0) return { query: trimmed, matches: partial, suggestion: null };
  }
  return { query: trimmed, matches: [], suggestion: '没有匹配的模型；报价里的 modelSlug 必须是已有模型，确认名称后再提交，不要编造 slug' };
}

/* --------------------------------------------------------------- validate */

export interface ValidateResult {
  path: string;
  valid: boolean;
  kind?: 'station' | 'post' | 'model' | null;
  issues?: { field: string; message: string }[];
}

/**
 * 按 payload 的形状判断种类：有 url 当站点，有 title 当评价，
 * 有 slug+vendor 当模型。
 * url 先判：站点也可能带 name，但绝不会带 vendor；
 * title 在模型上不存在，所以两者不会撞。
 */
export function inferKind(input: unknown): 'station' | 'post' | 'model' | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if ('url' in record) return 'station';
  if ('title' in record) return 'post';
  // 模型必须同时有 slug 和 vendor：只凭 slug 会和别的东西混淆。
  if ('slug' in record && 'vendor' in record) return 'model';
  return null;
}

export function validatePayload(input: unknown): { kind: 'station' | 'post' | 'model' | null; issues: { field: string; message: string }[] } {
  const kind = inferKind(input);
  if (kind === null) {
    return { kind: null, issues: [{ field: '', message: '无法判断种类：站点需要 url 字段，评价需要 title 字段，模型需要 slug 和 vendor 字段' }] };
  }
  // 禁用字段要先查：schema 会把未知字段剥掉，剥完再查就查不到了，
  // 而服务端是在剥之前拒的。
  const forbidden = findForbiddenAgentField(input);
  if (forbidden !== null) {
    return { kind, issues: [{ field: forbidden, message: 'Agent 投稿不允许这个字段，实测指标由平台自己采集' }] };
  }
  const schema = kind === 'station' ? agentStationSchema : kind === 'model' ? agentModelSchema : agentPostSchema;
  const result = schema.safeParse(input);
  if (result.success) return { kind, issues: [] };
  // 判成别的种类时，多余字段的报错本身就是线索；这里直接点明它被当成了什么，
  // 免得用户对着一串「缺少 summary/body」发呆。
  const misjudged = 'slug' in (input as Record<string, unknown>) && 'vendor' in (input as Record<string, unknown>) && kind !== 'model';
  const issues = result.error.issues.map(issue => ({
      field: issue.code === 'unrecognized_keys' ? [...issue.path, ...issue.keys].join('.') : issue.path.join('.'),
    message: issue.code === 'unrecognized_keys' ? '不认识这个字段，Agent 投稿不接受多余字段' : issue.message,
  }));
  if (misjudged) {
    issues.push({ field: '', message: `这条看起来是模型，但带了 ${kind === 'station' ? 'url' : 'title'} 字段，被当成${kind === 'station' ? '站点' : '评价'}了；模型不要带 url 或 title` });
  }
  return { kind, issues };
}

export async function validate(path: string): Promise<ValidateResult> {
  const raw = await readFile(path, 'utf8').catch(() => {
    throw new ZdError(EXIT.usage, `读不到文件：${path}`);
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ZdError(EXIT.validation, `不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const { kind, issues } = validatePayload(parsed);
  return issues.length === 0 ? { path, valid: true, kind } : { path, valid: false, kind, issues };
}

/* ----------------------------------------------------------------- submit */

export async function submitOne(
  input: unknown,
  options: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<AgentSubmitResponse> {
  const { kind, issues } = validatePayload(input);
  if (issues.length > 0 || kind === null) {
    throw new ZdError(EXIT.validation, `本地校验未通过：${issues[0]!.field} ${issues[0]!.message}`, { issues });
  }
  const token = options.token ?? (await resolveToken());
  const route = kind === 'station' ? API_ROUTES.createAgentStation
    : kind === 'model' ? API_ROUTES.createAgentModel
      : API_ROUTES.createAgentPost;
  return await request(route.path, { method: 'POST', body: input, token, fetchImpl: options.fetchImpl }) as AgentSubmitResponse;
}

export async function submitFile(path: string, options: { token?: string; fetchImpl?: typeof fetch } = {}): Promise<AgentSubmitResponse> {
  const raw = await readFile(path, 'utf8').catch(() => {
    throw new ZdError(EXIT.usage, `读不到文件：${path}`);
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ZdError(EXIT.validation, `不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return submitOne(parsed, options);
}

export interface BatchResult {
  total: number;
  submitted: { file: string; id: string; status: string; deduplicated: boolean }[];
  failed: { file: string; code: number; message: string }[];
}

/** 批量提交：逐个文件，单个失败不影响其余，最后汇总。 */
export async function submitBatch(
  dir: string,
  options: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<BatchResult> {
  const entries = await readdir(dir).catch(() => {
    throw new ZdError(EXIT.usage, `读不到目录：${dir}`);
  });
  const files = entries.filter(name => name.endsWith('.json')).sort();
  if (files.length === 0) throw new ZdError(EXIT.usage, `目录里没有 .json 文件：${dir}`);
  const token = options.token ?? (await resolveToken());
  const result: BatchResult = { total: files.length, submitted: [], failed: [] };
  for (const name of files) {
    try {
      const response = await submitFile(join(dir, name), { token, fetchImpl: options.fetchImpl });
      result.submitted.push({ file: name, id: response.submission.id, status: response.submission.status, deduplicated: response.deduplicated });
    } catch (error) {
      const zdd = error instanceof ZdError ? error : new ZdError(EXIT.network, String(error));
      result.failed.push({ file: name, code: zdd.code, message: zdd.message });
    }
  }
  return result;
}

/* ----------------------------------------------------------------- status */

export async function status(
  limit?: number,
  options: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<GetAgentStatusResponse> {
  const token = options.token ?? (await resolveToken());
  const query = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
  return await request(`${API_ROUTES.getAgentStatus.path}${query}`, { token, fetchImpl: options.fetchImpl }) as GetAgentStatusResponse;
}

/* ------------------------------------------------------------------- main */

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!;
    // `--` 之后一律当位置参数，不再按 flag 解析。
    if (token === '--') {
      positional.push(...rest.slice(index + 1));
      break;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = rest[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next;
        index++;
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

/**
 * 输出到 stdout，保证是单行 JSON，方便 Agent 管道解析。
 *
 * 这里统一脱敏而不是让每个调用点自己处理：早先只在 catch 分支抹了凭证，
 * 批量提交的结果走的是成功路径，里面的服务端 message 和文件名照样带出明文。
 */
function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(scrubSecret(value)) + '\n');
}

/**
 * 凭证形态的字符串。服务端签发的是 `zd_` + 32 字节随机数的 base64url
 * （server/src/agent-tokens.ts:40），固定 43 个字符。
 *
 * 早先写成「至少 16 个」会把 `zd_model_identifier_2026` 这类正常标识误抹；
 * 放宽到「至少 32 个」又误伤 45 字符的合法模型名。按精确长度匹配才能真正
 * 区分凭证和普通文本——这是唯一确定凭证样子的地方。
 */
const TOKEN_PATTERN = /zd_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

/**
 * 抹掉凭证。服务端错误消息、fetch 异常、用户误传的文件名都可能把明文
 * 带出来，统一在出口处理，不依赖每个调用点自觉。
 *
 * 键名也要抹：`detail` 里的对象键同样可能被拼进凭证。
 */
export function scrubSecret(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(TOKEN_PATTERN, 'zd_***');
  if (Array.isArray(value)) return value.map(scrubSecret);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      typeof key === 'string' ? key.replace(TOKEN_PATTERN, 'zd_***') : key,
      scrubSecret(child),
    ]));
  }
  return value;
}

/** 人类可读提示一律走 stderr，不污染 stdout。 */
function note(message: string): void {
  process.stderr.write(message + '\n');
}

export async function run(argv: string[]): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
  try {
    switch (command) {
      case 'login': {
        const key = typeof flags.key === 'string' ? flags.key : positional[0];
        if (!key) throw new ZdError(EXIT.usage, '用法：zdd login --key zd_xxx');
        const result = await login(key);
        note(`已登录 ${result.handle}，凭证保存在 ${result.savedTo}`);
        emit(result);
        return EXIT.ok;
      }
      case 'whoami': {
        emit(await whoami());
        return EXIT.ok;
      }
      case 'catalog': {
        emit(await catalog());
        return EXIT.ok;
      }
      case 'match': {
        const query = positional.join(' ').trim();
        if (!query) throw new ZdError(EXIT.usage, '用法：zdd match "模型名"');
        const { models } = await catalog();
        emit(matchModel(query, models));
        return EXIT.ok;
      }
      case 'validate': {
        const path = positional[0];
        if (!path) throw new ZdError(EXIT.usage, '用法：zdd validate ./x.json');
        const result = await validate(path);
        emit(result);
        return result.valid ? EXIT.ok : EXIT.validation;
      }
      case 'submit': {
        const batch = typeof flags.batch === 'string' ? flags.batch : undefined;
        if (batch !== undefined) {
          const result = await submitBatch(batch);
          emit(result);
          return result.failed.length === 0 ? EXIT.ok : EXIT.rejected;
        }
        const path = positional[0];
        if (!path) throw new ZdError(EXIT.usage, '用法：zdd submit ./x.json 或 zdd submit --batch ./dir/');
        emit(await submitFile(path));
        return EXIT.ok;
      }
      case 'status': {
        // 服务端接受 1..50；缺值和非法值都不能静默当成默认。
        let limit: number | undefined;
        if ('limit' in flags) {
          if (typeof flags.limit !== 'string') throw new ZdError(EXIT.usage, '--limit 需要一个值');
          limit = Number(flags.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
            throw new ZdError(EXIT.usage, '--limit 需要是 1~50 的整数');
          }
        }
        emit(await status(limit));
        return EXIT.ok;
      }
      case '':
      case 'help':
      case '--help':
        note(
          [
            'zdd —— 什么值得蹬 Agent 命令行',
            '',
            '  zdd login --key zd_xxx        保存凭证',
            '  zdd whoami                    身份与配额余量',
            '  zdd catalog                   厂商、模型、已有站点',
            '  zdd match "模型名"            模型名模糊匹配',
            '  zdd validate ./x.json         本地校验，不联网',
            '  zdd submit ./x.json           提交单个',
            '  zdd submit --batch ./dir/     批量提交',
            '  zdd status [--limit N]        审核进度与拒绝原因',
            '',
            '所有命令输出 JSON 到 stdout，提示信息走 stderr。',
          ].join('\n'),
        );
        emit({ ok: command === '' || command === 'help' || command === '--help' });
        return EXIT.ok;
      default:
        // 不回显输入：误把凭证当命令传进来时会原样打到终端和 Agent 记录里。
        throw new ZdError(EXIT.usage, '未知命令。运行 zdd help 查看用法');
    }
  } catch (error) {
    const zdd = error instanceof ZdError ? error : new ZdError(EXIT.network, error instanceof Error ? error.message : String(error));
    const message = scrubSecret(zdd.message) as string;
    note(`失败：${message}`);
    note(`建议：${NEXT_ACTION[zdd.code] ?? '未知错误'}`);
    emit({ ok: false, code: zdd.code, message, detail: scrubSecret(zdd.detail ?? null), nextAction: NEXT_ACTION[zdd.code] ?? null });
    return zdd.code;
  }
}

/** 只在被直接执行时跑，被测试 import 时不触发。 */
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath.endsWith('zdd.ts') || invokedPath.endsWith('zdd.js')) {
  run(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}

