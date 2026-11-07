/**
 * 站点 slug 的派生规则。飞书同步和投稿队列必须用同一套，
 * 否则同一个站点会被两个通道算成两条记录。
 *
 * 这里只放纯函数，不碰数据库：调用方拿到候选后再自己查库判重。
 */

/** 飞书一直将 www 和裸域名归为同组；入队后沿用这个身份，避免重复建站。 */
export function feishuHostnameKey(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

/** 把 hostname 归一成 slug 的正文部分：小写、非字母数字折成连字符、去首尾。 */
export function slugifyHost(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** 站点 slug 的可读形式，不含去重后缀。 */
export function stationSlugBase(identity: string): string {
  return `sub-${slugifyHost(identity)}`;
}

/**
 * 由 slug 正文派生的 8 位短哈希，用于可读 slug 撞车或超长时区分。
 * 用两路 FNV-1a 拼接而不是 createHash：shared 会被浏览器端打包，不能依赖 node:crypto。
 */
export function stationSlugSuffix(identity: string, salt = 0): string {
  const text = salt === 0 ? identity : `${identity}#${salt}`;
  const fnv = (seed: number, prime: number) => {
    let hash = seed;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, prime) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };
  return `${fnv(0x811c9dc5, 0x01000193)}${fnv(0x9e3779b9, 0x85ebca6b).slice(0, 4)}`.slice(0, 12);
}

/** slug 的最大长度，站点页面的路由和索引都以它为准。 */
export const STATION_SLUG_MAX = 100;
