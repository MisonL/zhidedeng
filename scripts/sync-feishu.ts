#!/usr/bin/env node
// 把飞书收集表里审核通过的记录提交到投稿队列。确定性脚本，不调用任何 LLM，对飞书只读。
//
//   LARKSUITE_CLI_CONFIG_DIR  lark-cli 配置目录。必填，不回落到默认的 ~/.lark-cli，防止读到其他组织的配置
//   FEISHU_BASE_TOKEN         多维表格 token
//   FEISHU_TABLE_ID           数据表 ID
//   SITE_URL                  站点地址。管理接口不对公网开放，在服务器本机运行，用 http://127.0.0.1:PORT
//   SYNC_TOKEN                管理接口密钥，至少 32 位。dry-run 缺省时跳过下架检测
//
//   node scripts/sync-feishu.ts [--dry-run] [--allow-skipped] [--no-removal]
//
// 任何读取失败都中止且不入队：把读取失败当成空表会生成错误的下架请求。
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feishuHostnameKey, MAX_RATE, MIN_RATE } from '@zhidedeng/shared';
import type { AdminBatchSubmitRequest, AdminBatchSubmitResponse, AdminSubmissionStateResponse, CatalogImportPost, CatalogImportStation } from '@zhidedeng/shared';

export interface RawRecord {
  recordId: string;
  fields: Record<string, unknown>;
}

interface SiteModel {
  slug: string;
  name: string;
}

const PAGE_SIZE = 200;
const BATCH_SIZE = 500;
const APPROVED = '通过';
const REQUIRED_COLUMNS = ['中转站名称', '网址', '提交类型', '审核状态', '提交时间'];
const REVIEW_TYPES = new Set(['使用评价', '避坑反馈']);
const SUBMISSION_TYPES = new Set(['推荐新站', '更新信息', ...REVIEW_TYPES]);
const DEFAULT_DESCRIPTION = '群友提交的中转站，信息未经平台核实。';
const ANONYMOUS = '匿名群友';
const LIMITS = { name: 60, nickname: 30, description: 300, body: 5000, excerpt: 100, payment: 20, payments: 10, modelLine: 120, offerLines: 100, url: 300 };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** record-list 文档没写返回结构，这里接受列式和对象式两种；认不出就抛错，绝不当成空表。 */
export function parseRecordPage(stdout: string): { records: RawRecord[]; columns: string[]; hasMore: boolean | null } {
  const parsed: unknown = JSON.parse(stdout);
  if (!isObject(parsed)) throw new Error('lark-cli 返回的不是 JSON 对象');
  if (parsed.ok === false || (typeof parsed.code === 'number' && parsed.code !== 0)) throw new Error('lark-cli 返回错误');
  const data = isObject(parsed.data) ? parsed.data : parsed;
  const hasMore = typeof data.has_more === 'boolean' ? data.has_more : null;

  if (Array.isArray(data.data) && Array.isArray(data.fields) && Array.isArray(data.record_id_list)) {
    const columns = data.fields.map(field => isObject(field) ? String(field.name ?? field.field_name) : String(field));
    const ids: unknown[] = data.record_id_list;
    if (ids.length !== data.data.length) throw new Error('记录 ID 与数据行数量不一致');
    const records = data.data.map((row: unknown, index): RawRecord => {
      if (!Array.isArray(row)) throw new Error('数据行不是数组');
      // 行比列短意味着这一页字段对不齐：按列名取「审核状态」会拿到 undefined，
      // 被当成未通过，进而生成下架请求。宁可中止。
      if (row.length !== columns.length) throw new Error(`第 ${index + 1} 行有 ${row.length} 个值，但列有 ${columns.length} 个`);
      return { recordId: String(ids[index]), fields: Object.fromEntries(columns.map((column, cell) => [column, row[cell]])) };
    });
    return { records, columns, hasMore };
  }

  const items = data.items ?? data.records;
  if (Array.isArray(items)) {
    const records = items.map((item: unknown): RawRecord => {
      if (!isObject(item) || !isObject(item.fields)) throw new Error('记录结构无法识别');
      return { recordId: String(item.record_id ?? item.id), fields: item.fields };
    });
    return { records, columns: [...new Set(records.flatMap(record => Object.keys(record.fields)))], hasMore };
  }
  throw new Error('lark-cli 返回结构无法识别');
}

/** 单元格可能是字符串、数字、选项数组或富文本片段数组。多个片段直接拼接，所以 ['通过','拒绝'] 不等于「通过」。 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(cellText).join('');
  if (isObject(value)) return cellText(value.text ?? value.name ?? value.value);
  return '';
}

function cellList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(cellText);
  const text = cellText(value);
  return text ? [text] : [];
}

function cellLink(value: unknown): string {
  const cell = Array.isArray(value) ? value[0] as unknown : value;
  if (isObject(cell) && typeof cell.link === 'string') return cell.link;
  const text = cellText(cell).trim();
  return text.match(/^\[[^\]]*\]\((.*)\)$/)?.[1] ?? text;
}

function clip(text: string, max: number) {
  return [...text].slice(0, max).join('');
}

/** 去掉控制字符和不可见的方向控制符。多行文本保留换行。 */
function cleanText(value: string, max: number) {
  return clip(value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\p{Cc}\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu, char => char === '\n' ? char : '').trim(), max);
}

function cleanLine(value: string, max: number) {
  return clip(cleanText(value, Infinity).replace(/\s+/g, ' '), max);
}

/** 只留协议、主机、路径。query、fragment 和账号信息可能带邀请码。 */
export function normalizeUrl(raw: string): { url: string; host: string } | null {
  const text = raw.trim();
  if (!text || text.length > LIMITS.url) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  return { url: url.href, host: feishuHostnameKey(url.hostname) };
}

function parseSubmittedAt(value: unknown): number | null {
  const text = cellText(value).trim();
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  if (/^\d{13}$/.test(text)) return Number(text);
  // 表格日期不带时区，按东八区理解。
  const local = text.replaceAll('/', '-').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(:\d{2})?)?$/);
  const time = local ? Date.parse(`${local[1]}T${local[2] ?? '00:00'}${local[3] ?? ':00'}+08:00`) : Date.parse(text);
  return Number.isNaN(time) ? null : time;
}

const normalizeModelName = (name: string) => name.toLowerCase().replace(/[\s_.-]+/g, '');

function parseOffers(raw: unknown, models: Map<string, string>, report: (message: string) => void) {
  const offers = new Map<string, number>();
  const lines = cellText(raw).split(/\r?\n/).map(line => cleanLine(line, LIMITS.modelLine)).filter(Boolean);
  if (lines.length > LIMITS.offerLines) report(`倍率行超过 ${LIMITS.offerLines} 行，其余忽略`);
  for (const line of lines.slice(0, LIMITS.offerLines)) {
    const parts = line.match(/^(.+?)\s*[=＝]\s*(.+)$/);
    if (!parts) {
      report(`倍率行格式不对，已跳过：${line}`);
      continue;
    }
    const modelSlug = models.get(normalizeModelName(parts[1]));
    if (!modelSlug) {
      report(`模型匹配不到，已跳过：${line}`);
      continue;
    }
    const rate = /^\d+(\.\d+)?\s*[xX倍]?$/.test(parts[2]) ? Number.parseFloat(parts[2]) : Number.NaN;
    if (!Number.isFinite(rate)) {
      report(`倍率必须是大于 0 的数字，已跳过：${line}`);
      continue;
    }
    if (rate < MIN_RATE || rate > MAX_RATE) {
      report(`倍率超出 ${MIN_RATE}~${MAX_RATE} 范围，已跳过`);
      continue;
    }
    offers.set(modelSlug, rate);
  }
  return [...offers].map(([modelSlug, rate]) => ({ modelSlug, rate })).sort((a, b) => a.modelSlug.localeCompare(b.modelSlug));
}

interface Submission {
  recordId: string;
  type: string;
  name: string;
  site: { url: string; host: string } | null;
  offers: CatalogImportStation['offers'];
  threshold: number | null;
  payments: string[];
  score: number | null;
  text: string;
  nickname: string;
  time: number;
}

type StationItem = {
  kind: 'station'; originKey: string; action: 'upsert'; payload: Omit<CatalogImportStation, 'slug'>;
};
type PostItem = {
  kind: 'post'; originKey: string;
  payload: Omit<CatalogImportPost, 'recordId' | 'stationSlug'> & { hostname: string };
};
type RemovalItem = { kind: 'station'; originKey: string; action: 'remove'; payload: { slug: string; submissionId: string } };

function parseSubmission(record: RawRecord, models: Map<string, string>, notes: string[]): Submission | string {
  const { recordId, fields } = record;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(recordId)) return '记录 ID 不合法';
  const name = cleanLine(cellText(fields['中转站名称']), LIMITS.name);
  if (!name) return '缺少中转站名称';
  const type = cellText(fields['提交类型']);
  if (!SUBMISSION_TYPES.has(type)) return '提交类型无法识别';
  const time = parseSubmittedAt(fields['提交时间']);
  if (time === null) return '提交时间无法解析';
  const rawUrl = cellLink(fields['网址']);
  const site = normalizeUrl(rawUrl);
  if (rawUrl && !site) return '网址无效，只接受 http/https';

  const report = (message: string) => notes.push(`${recordId}：${message}`);
  const thresholdText = cellText(fields['最低充值（元）']).trim();
  const threshold = /^\d+(\.\d+)?$/.test(thresholdText) ? Number(thresholdText) : null;
  if (thresholdText && threshold === null) report('最低充值不是数字，已按未填写处理');
  const scoreText = cellText(fields['推荐指数']).trim();
  const score = /^[1-5]$/.test(scoreText) ? Number(scoreText) : null;
  if (scoreText && score === null) report('推荐指数不在 1-5 之间，已忽略');

  return {
    recordId, type, name, site, threshold, score, time,
    offers: parseOffers(fields['模型与倍率'], models, report),
    payments: cellList(fields['支付方式']).map(item => cleanLine(item, LIMITS.payment)).filter(Boolean).slice(0, LIMITS.payments),
    text: cleanText(cellText(fields['使用体验']), LIMITS.body),
    nickname: cleanLine(cellText(fields['展示昵称']), LIMITS.nickname),
  };
}

/**
 * 只接触审核状态严格等于「通过」的记录；其他记录连内容都不进日志。审核备注从不读取。
 * 同一站点（按主机名归并）的站点信息逐项取最新一条非空的值，所以一条没填报价的评价不会冲掉报价。
 */
export function buildBatch(records: RawRecord[], models: SiteModel[]) {
  const skipped: string[] = [];
  const notes: string[] = [];
  const modelIndex = new Map(models.flatMap(model => [[normalizeModelName(model.name), model.slug], [normalizeModelName(model.slug), model.slug]] as const));

  const submissions: Submission[] = [];
  for (const record of records) {
    if (cellText(record.fields['审核状态']) !== APPROVED) continue;
    const parsed = parseSubmission(record, modelIndex, notes);
    if (typeof parsed === 'string') skipped.push(`${record.recordId}：${parsed}`);
    else submissions.push(parsed);
  }
  // 从新到旧。同一时间按记录 ID 定序，保证结果与读取顺序无关。
  submissions.sort((a, b) => b.time - a.time || a.recordId.localeCompare(b.recordId));

  // 没填网址的评价按站名归到已有站点。
  const hostByName = new Map<string, string>();
  for (const { site, name } of submissions) {
    if (site && !hostByName.has(name.toLowerCase())) hostByName.set(name.toLowerCase(), site.host);
  }
  const groups = new Map<string, Submission[]>();
  for (const submission of submissions) {
    const host = submission.site?.host ?? hostByName.get(submission.name.toLowerCase());
    if (!host) {
      skipped.push(`${submission.recordId}：缺少网址，也找不到同名站点`);
      continue;
    }
    groups.set(host, [...(groups.get(host) ?? []), submission]);
  }

  const stations: StationItem[] = [];
  const posts: PostItem[] = [];
  for (const [host, group] of groups) {
    const name = group[0].name;
    const site = group.find(item => item.site)!.site!;
    const hostname = new URL(site.url).hostname.toLowerCase();
    stations.push({
      kind: 'station', originKey: host.toLowerCase(), action: 'upsert',
      payload: {
        name, url: site.url,
        description: cleanText(group.find(item => !REVIEW_TYPES.has(item.type) && item.text)?.text ?? DEFAULT_DESCRIPTION, LIMITS.description),
        rechargeThreshold: group.find(item => item.threshold !== null)?.threshold ?? null,
        paymentMethods: group.find(item => item.payments.length)?.payments ?? [],
        offers: group.find(item => item.offers.length)?.offers ?? [],
      },
    });
    for (const item of group.filter(entry => REVIEW_TYPES.has(entry.type))) {
      if (!item.text) {
        notes.push(`${item.recordId}：评价没有正文，未生成文章`);
        continue;
      }
      const excerpt = cleanLine(item.text, LIMITS.excerpt);
      posts.push({
        kind: 'post', originKey: item.recordId,
        payload: {
          hostname, title: `${name} · ${item.type}`,
          summary: item.score === null ? excerpt : `推荐指数 ${item.score}/5 · ${excerpt}`,
          body: item.text, authorName: item.nickname || ANONYMOUS, publishedAt: new Date(item.time).toISOString(),
        },
      });
    }
  }
  stations.sort((a, b) => a.originKey.localeCompare(b.originKey));
  posts.sort((a, b) => a.originKey.localeCompare(b.originKey));
  skipped.sort();
  notes.sort();
  const payload = { channel: 'feishu' as const, items: [...stations, ...posts] };
  return { payload, skipped, notes, validStations: stations.length };
}

/** 按飞书分组的 hostname 比较，slug 只取服务端返回的值，不在脚本里派生。 */
export function planBatch(batch: AdminBatchSubmitRequest, state: AdminSubmissionStateResponse | null, allowSkipped = false, allowRemoval = true) {
  const upserts = batch.items.filter(item => item.kind === 'station' && (item.action ?? 'upsert') === 'upsert');
  const incoming = new Set(upserts.map(item => feishuHostnameKey(item.originKey)));
  const current = new Set(state?.stations.map(station => feishuHostnameKey(station.originKey)));
  // 默认自动下架：表格里删掉的站点就该下线，这是自动运行的前提。
  // 防误删靠的是读取阶段的闸门（逐页字段校验、行长度校验、解析失败即中止、
  // 有效站点数为 0 即中止）和下架本身的软删除——站点只是标记下线，随时能恢复。
  // --no-removal 留作手动关闭的口子。
  const removals: RemovalItem[] = allowSkipped || !allowRemoval ? [] : state?.stations.filter(station => !incoming.has(feishuHostnameKey(station.originKey))).map(station => ({
    kind: 'station', originKey: feishuHostnameKey(station.originKey), action: 'remove', payload: { slug: station.slug, submissionId: station.submissionId },
  })) ?? [];
  return {
    payload: { ...batch, items: [...batch.items, ...removals] }, removals,
    added: state === null ? null : [...incoming].filter(hostname => !current.has(hostname)).length,
    updated: state === null ? null : [...incoming].filter(hostname => current.has(hostname)).length,
  };
}

class UsageError extends Error {}
class UnsafeBatchError extends Error {}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new UsageError(`缺少环境变量 ${name}`);
  return value;
}

function readConfig(dryRun: boolean) {
  const configDir = requireEnv('LARKSUITE_CLI_CONFIG_DIR');
  if (resolve(configDir) === resolve(homedir(), '.lark-cli')) throw new UsageError('LARKSUITE_CLI_CONFIG_DIR 不能指向默认目录 ~/.lark-cli');
  const site = new URL(requireEnv('SITE_URL'));
  if (site.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(site.hostname)) throw new UsageError('SITE_URL 必须是 https（本机地址除外）');
  return {
    configDir, site,
    baseToken: requireEnv('FEISHU_BASE_TOKEN'),
    tableId: requireEnv('FEISHU_TABLE_ID'),
    syncToken: dryRun ? process.env.SYNC_TOKEN ?? '' : requireEnv('SYNC_TOKEN'),
  };
}

type Config = ReturnType<typeof readConfig>;

function runLark(args: string[], configDir: string) {
  return new Promise<string>((done, fail) => {
    execFile('lark-cli', args, { env: { ...process.env, LARKSUITE_CLI_CONFIG_DIR: configDir }, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) fail(new Error(`lark-cli 退出码 ${String(error.code)}：${stderr.trim()}`));
      else done(stdout);
    });
  });
}

/** 分页串行读取全部记录（record-list 禁止并发）。 */
async function readAllRecords(config: Config) {
  const records: RawRecord[] = [];
  const columns = new Set<string>();
  for (;;) {
    const page = parseRecordPage(await runLark(['base', '+record-list', '--as', 'bot', '--base-token', config.baseToken, '--table-id', config.tableId, '--offset', String(records.length), '--limit', String(PAGE_SIZE)], config.configDir));
    // 每页单独校验必填字段。只在读完后查一次是不够的：
    // 分页里混入列式与对象式结构时，某一页的字段会解析成空，
    // 那些记录读不到「审核状态」就被当成未通过——结果静默生成下架请求，
    // 日志里看不出任何异常。
    const pageColumns = new Set(page.columns);
    const missingOnPage = REQUIRED_COLUMNS.filter(column => !pageColumns.has(column));
    if (page.records.length > 0 && missingOnPage.length > 0) {
      throw new Error(`第 ${records.length / PAGE_SIZE + 1} 页缺少字段：${missingOnPage.join('、')}，中止同步`);
    }
    records.push(...page.records);
    page.columns.forEach(column => columns.add(column));
    if (page.records.length === 0 || !(page.hasMore ?? page.records.length === PAGE_SIZE)) break;
  }
  // 字段被改名时所有记录都会变成「未通过」，会生成错误的下架请求，所以这里中止。
  const missing = REQUIRED_COLUMNS.filter(column => !columns.has(column));
  if (records.length > 0 && missing.length > 0) throw new Error(`表格缺少字段：${missing.join('、')}，中止同步`);
  return records;
}

async function readModels(site: URL) {
  const models: SiteModel[] = [];
  for (let page = 1; ; page++) {
    const response = await fetch(new URL(`/api/models?page=${page}&pageSize=50`, site));
    if (!response.ok) throw new Error(`读取模型列表失败：HTTP ${response.status}`);
    const body = await response.json() as { items: SiteModel[]; total: number };
    models.push(...body.items);
    if (body.items.length === 0 || models.length >= body.total) return models;
  }
}

async function readSubmissionState(config: Config): Promise<AdminSubmissionStateResponse> {
  const response = await fetch(new URL('/api/admin/submissions/state', config.site), {
    headers: { authorization: `Bearer ${config.syncToken}` }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`读取投稿状态失败：HTTP ${response.status} ${await response.text()}`);
  const body: unknown = await response.json();
  if (!isObject(body) || !Array.isArray(body.stations) || !body.stations.every((station: unknown) => isObject(station)
    && typeof station.slug === 'string' && station.slug.length > 0 && station.slug.length <= 200
    && typeof station.originKey === 'string' && station.originKey.length > 0 && station.originKey.length <= 253
    && typeof station.submissionId === 'string' && station.submissionId.trim().length > 0 && station.submissionId.length <= 200
    && typeof station.name === 'string' && (station.url === null || typeof station.url === 'string'))) {
    throw new Error('线上投稿状态结构无法识别，中止同步');
  }
  return body as unknown as AdminSubmissionStateResponse;
}

function batchResult(body: unknown, items: AdminBatchSubmitRequest['items']): AdminBatchSubmitResponse {
  if (!isObject(body) || typeof body.batchId !== 'string' || !body.batchId || !Array.isArray(body.results) || body.results.length !== items.length
    || !body.results.every((result: unknown, index) => {
      if (!isObject(result) || result.kind !== items[index].kind || result.originKey !== items[index].originKey) return false;
      if (result.error !== undefined) return isObject(result.error) && typeof result.error.code === 'string' && typeof result.error.message === 'string';
      return typeof result.id === 'string' && result.id.length > 0 && typeof result.status === 'string'
        && ['pending', 'approved', 'rejected', 'superseded'].includes(result.status);
    })) throw new Error('批次入队响应结构无法识别，请核对服务端批次结果');
  return body as unknown as AdminBatchSubmitResponse;
}

async function main(dryRun: boolean, allowSkipped: boolean, allowRemoval: boolean, config: Config) {
  const records = await readAllRecords(config);
  const models = await readModels(config.site);
  const { payload: batch, skipped, notes, validStations } = buildBatch(records, models);
  const stationCount = validStations;
  const postCount = batch.items.filter(item => item.kind === 'post').length;
  console.log(`读取 ${records.length} 条记录，成功解析 ${stationCount} 个站点、${postCount} 篇评价，无法解析 ${skipped.length} 条记录`);
  for (const line of skipped) console.log(`[跳过] ${line}`);
  for (const line of notes) console.log(`[提示] ${line}`);
  if (skipped.length > 0 && !allowSkipped) {
    throw new UnsafeBatchError(`有 ${skipped.length} 条记录无法解析，为避免误下架已中止。修正数据后重试，或用 --allow-skipped 跳过这些记录但不同步下架`);
  }
  if (allowSkipped) console.error('[警告] 本次不同步下架：已启用 --allow-skipped，仅提交有效的新增、更新和评价');
  let state: AdminSubmissionStateResponse | null = null;
  if (config.syncToken) state = await readSubmissionState(config);
  else console.log('跳过下架检测：未配置 SYNC_TOKEN');
  if (validStations === 0 && state !== null && state.stations.length > 0) {
    throw new UnsafeBatchError(`成功解析的站点数为 0，线上仍有 ${state.stations.length} 个站点，为避免误下架已中止。请确认表格内容和读取结果后重试`);
  }
  const { payload, removals, added, updated } = planBatch(batch, state, allowSkipped, allowRemoval);
  console.log(state === null
    ? `同步计划：上架/更新 ${stationCount}，评价 ${postCount}，下架未检测`
    : `同步计划：新增 ${added}，更新 ${updated}，下架 ${removals.length}，评价 ${postCount}`);
  for (const item of removals) console.log(`[下架] ${item.originKey}：${item.payload.slug}`);
  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const batchId = randomUUID();
  const result: AdminBatchSubmitResponse = { batchId, results: [] };
  // 串行分块，共用同一 batchId；空批次保留一次请求，返回明确的入队结果。
  for (let offset = 0; offset < Math.max(payload.items.length, 1); offset += BATCH_SIZE) {
    const items = payload.items.slice(offset, offset + BATCH_SIZE);
    const response = await fetch(new URL('/api/admin/submissions/batch', config.site), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.syncToken}` },
      body: JSON.stringify({ ...payload, batchId, items }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`批次 ${batchId} 第 ${offset / BATCH_SIZE + 1} 块入队失败：HTTP ${response.status} ${await response.text()}`);
    const chunk = batchResult(await response.json(), items);
    if (chunk.batchId !== batchId) throw new Error(`批次 ${batchId} 入队响应的 batchId 不一致，请核对服务端批次结果`);
    // 立即报告本块错误，后续 HTTP 失败不能遮住已经返回的逐条失败详情。
    for (const item of chunk.results.filter(item => item.error)) console.log(`[失败] ${item.kind} ${item.originKey}：${item.error!.code} ${item.error!.message}`);
    result.results.push(...chunk.results);
  }
  const failed = result.results.filter(item => item.error);
  // 结果已按请求顺序校验；同 hostname 的遗留实体各有下架条目，按位置逐条对账。
  const accepted = payload.items.filter((_item, index) => !result.results[index].error);
  const current = new Set(state?.stations.map(station => feishuHostnameKey(station.originKey)));
  const stations = new Set(accepted.filter(item => item.kind === 'station' && (item.action ?? 'upsert') === 'upsert')
    .map(item => feishuHostnameKey(item.originKey)));
  const newCount = [...stations].filter(hostname => !current.has(hostname)).length;
  const updateCount = stations.size - newCount;
  const removeCount = accepted.filter(item => item.kind === 'station' && item.action === 'remove').length;
  const reviewCount = accepted.filter(item => item.kind === 'post').length;
  console.log(`批次 ${result.batchId} 入队完成：新增 ${newCount}，更新 ${updateCount}，下架 ${removeCount}，评价 ${reviewCount}，失败 ${failed.length}`);
  if (failed.length > 0) throw new Error(`批次 ${result.batchId} 有 ${failed.length} 条入队失败`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const allowSkipped = process.argv.includes('--allow-skipped');
  // 默认自动下架；--no-removal 只同步新增和更新。
  const allowRemoval = !process.argv.includes('--no-removal');
  const secrets = () => ['FEISHU_BASE_TOKEN', 'SYNC_TOKEN'].map(name => process.env[name]).filter((value): value is string => Boolean(value));
  try {
    await main(dryRun, allowSkipped, allowRemoval, readConfig(dryRun));
  } catch (error) {
    // lark-cli 的错误输出可能回显命令行参数，打印前抹掉 token。
    const message = secrets().reduce((text, secret) => text.replaceAll(secret, '***'), error instanceof Error ? error.message : String(error));
    console.error(`同步失败：${message}`);
    process.exitCode = error instanceof UnsafeBatchError ? 2 : 1;
  }
}
