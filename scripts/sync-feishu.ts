#!/usr/bin/env node
// 把飞书收集表里审核通过的记录全量同步到站点 catalog。确定性脚本，不调用任何 LLM，对飞书只读。
//
//   LARKSUITE_CLI_CONFIG_DIR  lark-cli 配置目录。必填，不回落到默认的 ~/.lark-cli，防止读到其他组织的配置
//   FEISHU_BASE_TOKEN         多维表格 token
//   FEISHU_TABLE_ID           数据表 ID
//   SITE_URL                  站点地址。导入接口不对公网开放，在服务器本机运行，用 http://127.0.0.1:PORT
//   SYNC_TOKEN                导入接口密钥，至少 32 位（--dry-run 时不需要）
//
//   node scripts/sync-feishu.ts [--dry-run]
//
// 任何读取失败都中止且不发布：导入是全量覆盖，把读取失败当成空表会清空全部群友提交。
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RATE, MIN_RATE } from '@zhidedeng/shared';
import type { CatalogImportPost, CatalogImportRequest, CatalogImportResponse, CatalogImportStation } from '@zhidedeng/shared';

export interface RawRecord {
  recordId: string;
  fields: Record<string, unknown>;
}

interface SiteModel {
  slug: string;
  name: string;
}

const PAGE_SIZE = 200;
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
  return { url: url.href, host: url.hostname.toLowerCase().replace(/^www\./, '') };
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
export function buildImport(records: RawRecord[], models: SiteModel[]) {
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

  const stations: CatalogImportStation[] = [];
  const posts: CatalogImportPost[] = [];
  for (const [host, group] of groups) {
    const slug = clip(`sub-${host.replace(/[^a-z0-9]+/g, '-')}`, 124);
    const name = group[0].name;
    stations.push({
      slug, name,
      url: group.find(item => item.site)!.site!.url,
      description: cleanText(group.find(item => !REVIEW_TYPES.has(item.type) && item.text)?.text ?? DEFAULT_DESCRIPTION, LIMITS.description),
      rechargeThreshold: group.find(item => item.threshold !== null)?.threshold ?? null,
      paymentMethods: group.find(item => item.payments.length)?.payments ?? [],
      offers: group.find(item => item.offers.length)?.offers ?? [],
    });
    for (const item of group.filter(entry => REVIEW_TYPES.has(entry.type))) {
      if (!item.text) {
        notes.push(`${item.recordId}：评价没有正文，未生成文章`);
        continue;
      }
      const excerpt = cleanLine(item.text, LIMITS.excerpt);
      posts.push({
        recordId: item.recordId, stationSlug: slug, title: `${name} · ${item.type}`,
        summary: item.score === null ? excerpt : `推荐指数 ${item.score}/5 · ${excerpt}`,
        body: item.text, authorName: item.nickname || ANONYMOUS, publishedAt: new Date(item.time).toISOString(),
      });
    }
  }
  stations.sort((a, b) => a.slug.localeCompare(b.slug));
  posts.sort((a, b) => a.recordId.localeCompare(b.recordId));
  skipped.sort();
  notes.sort();
  const payload: CatalogImportRequest = { stations, posts };
  return { payload, skipped, notes };
}

class UsageError extends Error {}

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
    syncToken: dryRun ? '' : requireEnv('SYNC_TOKEN'),
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
    records.push(...page.records);
    page.columns.forEach(column => columns.add(column));
    if (page.records.length === 0 || !(page.hasMore ?? page.records.length === PAGE_SIZE)) break;
  }
  // 字段被改名时所有记录都会变成「未通过」，全量同步就会清空站点，所以这里中止。
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

async function main(dryRun: boolean, config: Config) {
  const records = await readAllRecords(config);
  const models = await readModels(config.site);
  const { payload, skipped, notes } = buildImport(records, models);
  console.log(`读取 ${records.length} 条记录，将发布 ${payload.stations.length} 个站点、${payload.posts.length} 篇评价，跳过 ${skipped.length} 条坏记录`);
  for (const line of skipped) console.log(`[跳过] ${line}`);
  for (const line of notes) console.log(`[提示] ${line}`);
  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const response = await fetch(new URL('/api/admin/import', config.site), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.syncToken}` },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`导入失败：HTTP ${response.status} ${await response.text()}`);
  const result = await response.json() as CatalogImportResponse;
  console.log(`导入完成：${result.changed ? '内容有变化' : '内容无变化'}，站点 ${result.stations}，报价 ${result.offers}，文章 ${result.posts}`);
  // 旧版服务端的响应里没有 skipped，这里按可选处理，脚本可以先于服务端升级。
  for (const line of result.skipped ?? []) console.log(`[跳过] ${line.slug}：${line.reason}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const secrets = () => ['FEISHU_BASE_TOKEN', 'SYNC_TOKEN'].map(name => process.env[name]).filter((value): value is string => Boolean(value));
  try {
    await main(dryRun, readConfig(dryRun));
  } catch (error) {
    // lark-cli 的错误输出可能回显命令行参数，打印前抹掉 token。
    const message = secrets().reduce((text, secret) => text.replaceAll(secret, '***'), error instanceof Error ? error.message : String(error));
    console.error(`同步失败：${message}`);
    process.exitCode = 1;
  }
}
