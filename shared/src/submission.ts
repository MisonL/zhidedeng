import { z } from 'zod';
import { MAX_RATE, MIN_RATE } from './domain.ts';
import { isPrivateHostname } from './net.ts';

/**
 * 投稿 payload 的校验规则。
 * 服务端和 `zdd` CLI 共用这一份定义，避免本地通过、服务端拒绝的漂移。
 */

/**
 * 控制字符与双向控制符。
 *
 * NUL、C0 控制符和 U+202A–202E / U+2066–2069 这类双向覆盖符不是正常内容：
 * 它们会破坏下游的文本处理（日志、导出、搜索），双向符还能在标题里制造
 * 「看到的是 A、实际是 B」的视觉欺骗。允许 \n 与 \t，其余拒绝。
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;

/** 单行文本：非空，长度受限，不含控制字符，去掉首尾后仍非空。 */
export const text = (max: number) => z.string().min(1).max(max)
  .refine(value => !CONTROL_CHARS.test(value), '内容包含不可见的控制字符')
  .refine(value => value.trim().length > 0, '内容不能为空');

/** 多行文本：额外允许换行，其余规则同上。 */
export const multiline = (max: number) => text(max);

/** 价格倍率，范围来自领域常量。 */
export const offerRate = z.number().refine(rate => rate >= MIN_RATE && rate <= MAX_RATE, {
  error: issue => ({ message: `倍率 ${String(issue.input)} 超出 ${MIN_RATE}~${MAX_RATE} 范围` }),
});

/**
 * 计价口径。同一个 rate 在不同口径下不可比，榜单把「数字越小越便宜」当成
 * 普适结论是错的——输入价 0.3 和打包价 0.3 说的根本不是一件事。
 */
export const rateBasis = z.enum(['blended', 'input', 'output', 'package']);

/**
 * 可入库的站点网址：http/https，不带查询串、片段和账号密码，且不指向内网。
 *
 * 内网判定与 Agent 通道共用同一套规则。原先这里完全不判，导致同一个地址
 * 在 Agent 通道 400、在飞书/站内投稿与全量导入却能 200 入库并展示给全站用户，
 * 弹到 127.0.0.1 或云元数据地址上。服务端目前不抓取站点 URL，所以现在的影响
 * 是「把内网地址当站点链接发布」；将来加可用性探测时它就是 SSRF。
 */
export const httpUrl = z.string().max(300).refine(value => {
  if (value.includes('?') || value.includes('#')) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    return !isPrivateHostname(url.hostname);
  } catch {
    return false;
  }
}).transform(value => normalizeFqdnDots(value));

/**
 * 去掉 URL 里 hostname 末尾的 FQDN 点：`https://example.com./` → `https://example.com/`。
 *
 * 绝对域名末尾带点是合法写法，和同一个站不带点完全等价。归一必须发生在**写库之前**，
 * 否则库里会同时存在两种写法，而任何一处忘记做「去尾点」的比较（服务端认领、同步脚本、
 * 审核台、将来的新代码）都会把同一站算成两条。放在 schema 出口就一次性覆盖投稿、
 * 同步、导入与 Agent 四条入口。
 */
function normalizeFqdnDots(value: string): string {
  try {
    const url = new URL(value);
    if (!url.hostname.endsWith('.')) return value;
    url.hostname = url.hostname.replace(/\.+$/, '');
    return url.toString();
  } catch {
    return value;
  }
}

/** 模型和厂商的 slug 共用同一套规则：小写字母、数字和连字符，最长 64。 */
const slugPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
/**
 * 前端表单会把 slug 转小写，服务端也照做，避免「UI 能过、直接调接口被拒」。
 * 报错带上规则本身，否则调用方只看到「请求参数无效」。
 */
export const adminSlug = z.string().trim().toLowerCase().regex(slugPattern, {
  error: '只能用小写字母、数字和连字符，且以字母或数字开头，最长 64 位',
});

export const stationSchema = z.object({
  name: text(60),
  description: text(300),
  url: httpUrl,
  rechargeThreshold: z.number().min(0).nullable(),
  paymentMethods: z.array(text(20)).max(10),
  // 每一项都要 strict。外层 z.object 默认只剥掉多余字段，元素不 strict 时
  // 写了 inputRate / outputRate / weight 这类不存在的字段会被静默丢弃，
  // 提交方以为生效了、榜上却没有——比报错难查得多。
  // 报价 = 倍率 + 计价口径 + 来源时间。只给 rate 时按 blended（整站混合倍率）读，
  // 与历史数据一致；要表达「这是输入价」必须显式给 basis，否则两个不可比的
  // 数字会并排排在同一张榜上。
  offers: z.array(z.strictObject({
    modelSlug: text(200),
    rate: offerRate,
    basis: rateBasis.optional(),
    // 报价来源时间。允许带时区偏移（中文站点常见 +08:00），与 postSchema 的
    // publishedAt 同一套规则。
    quotedAt: z.iso.datetime({ offset: true }).nullish(),
  })).max(100),
}).refine(station => new Set(station.offers.map(offer => offer.modelSlug)).size === station.offers.length, '存在重复的报价');

export const postSchema = z.object({
  title: text(100), summary: text(200), body: text(5000), authorName: text(30),
  // publishedAt 必须接受带时区偏移的时间：Agent 从中文站点抓到的发布时间通常是
  // `2026-11-15T10:00:00+08:00`，默认的 iso.datetime() 只认 UTC 的 `Z`，
  // 于是「原文发布时间」这个字段在最常见的取值上直接被判非法，Agent 只能放弃填它。
  authorHandle: text(200).nullish(), hostname: text(253).nullish(), publishedAt: z.iso.datetime({ offset: true }).nullish(),
});

/**
 * 补录模型。规划 4.2 承诺过这条通道，但服务端只实现了物化侧，
 * 提交侧一直缺——模型此前只能由管理员直接建。
 * slug 冲突时服务端返回 409 MODEL_EXISTS，不会静默改建已有模型。
 */
export const modelSchema = z.object({
  slug: adminSlug,
  vendor: adminSlug,
  name: text(60),
  description: text(200),
});

export type StationPayload = z.infer<typeof stationSchema>;
export type PostPayload = z.infer<typeof postSchema>;
export type ModelPayload = z.infer<typeof modelSchema>;

/**
 * Agent 接口收得更紧：不允许多余字段，也不允许提交实测指标类字段。
 * CLI 和服务端用同一份，否则本地通过了服务端还是会拒。
 */
export const agentStationSchema = stationSchema.strict();
export const agentPostSchema = postSchema.omit({ authorHandle: true }).strict();
export const agentModelSchema = modelSchema.strict();

/** 规范化后比对的禁用字段名（下划线、连字符、大小写都不影响判断）。 */
export const forbiddenAgentFields: ReadonlySet<string> = new Set([
  'uptime', 'firsttokenlatencyms', 'foundedat', 'status', 'score', 'lowestrate',
  'apikey', 'token', 'password', 'secret', 'authorhandle',
  'accesstoken', 'refreshtoken', 'clientsecret', 'privatekey', 'authorization', 'credentials',
]);

/** 返回第一个命中禁用规则的字段路径，没有则返回 null。递归查嵌套对象。 */
export function findForbiddenAgentField(input: unknown): string | null {
  const pending: { value: unknown; path: string }[] = [{ value: input, path: '' }];
  while (pending.length > 0) {
    const { value, path } = pending.pop()!;
    if (typeof value !== 'object' || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((child, index) => pending.push({ value: child, path: path ? `${path}.${index}` : String(index) }));
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      const field = path ? `${path}.${key}` : key;
      if (forbiddenAgentFields.has(key.replace(/[_-]/g, '').toLowerCase())) return field;
      pending.push({ value: child, path: field });
    }
  }
  return null;
}
