import { z } from 'zod';
import { MAX_RATE, MIN_RATE } from './domain.ts';

/**
 * 投稿 payload 的校验规则。
 * 服务端和 `zdd` CLI 共用这一份定义，避免本地通过、服务端拒绝的漂移。
 */

/** 单行文本：非空，长度受限，去掉首尾后仍非空。 */
export const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, '内容不能为空');

/** 价格倍率，范围来自领域常量。 */
export const offerRate = z.number().refine(rate => rate >= MIN_RATE && rate <= MAX_RATE, {
  error: issue => ({ message: `倍率 ${String(issue.input)} 超出 ${MIN_RATE}~${MAX_RATE} 范围` }),
});

/** 可入库的站点网址：http/https，不带查询串、片段和账号密码。 */
export const httpUrl = z.string().max(300).refine(value => {
  if (value.includes('?') || value.includes('#')) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
});

/** 模型和厂商的 slug 共用同一套规则：小写字母、数字和连字符，最长 64。 */
const slugPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const adminSlug = z.string().trim().regex(slugPattern);

export const stationSchema = z.object({
  name: text(60),
  description: text(300),
  url: httpUrl,
  rechargeThreshold: z.number().min(0).nullable(),
  paymentMethods: z.array(text(20)).max(10),
  offers: z.array(z.object({ modelSlug: text(200), rate: offerRate })).max(100),
}).refine(station => new Set(station.offers.map(offer => offer.modelSlug)).size === station.offers.length, '存在重复的报价');

export const postSchema = z.object({
  title: text(100), summary: text(200), body: text(5000), authorName: text(30),
  authorHandle: text(200).nullish(), hostname: text(253).nullish(), publishedAt: z.iso.datetime().nullish(),
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
