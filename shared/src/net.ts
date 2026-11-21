/**
 * 内网 / 保留地址判定。服务端与 `zdd` CLI 共用，投稿表单也用它做前置提示。
 *
 * 这里判的是「字面量」，不做 DNS 解析：任何「公网域名解析到 127.0.0.1」的形式
 * （nip.io、sslip.io、localtest.me 之类）都拦不住。真正要抓取时才需要解析后
 * 再校验一次——目前服务端不对站点 URL 发起任何请求，所以这条边界够用；
 * 将来若加上可用性探测，必须补上解析后校验与重定向校验。
 */

function ipv4ToParts(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map(part => Number(part));
  return numbers.every(number => Number.isInteger(number) && number >= 0 && number <= 255) ? numbers : null;
}

export function isPrivateIpv4(parts: number[]): boolean {
  const [first, second] = parts;
  return first === 0 || first === 10 || first === 127
    || (first === 172 && second! >= 16 && second! <= 31)
    || (first === 192 && second === 168) || (first === 169 && second === 254)
    // 运营商级 NAT、基准测试网段、文档保留段、组播与保留段都不能作为公开站点目标。
    || (first === 100 && second! >= 64 && second! <= 127)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 192 && second === 0) || (first === 198 && second === 51) || (first === 203 && second === 113)
    || first! >= 224;
}

/** 把 IPv6 的两个 16 位分组还原成点分 IPv4，用于识别内嵌 IPv4 的转换前缀。 */
export function wordsToIpv4(high: number, low: number): number[] {
  return [high >> 8, high & 255, low >> 8, low & 255];
}

/** 本机、局域网、保留段的主机名（不含字面 IP）。 */
const PRIVATE_TLDS = ['localhost', 'local', 'internal', 'example'];
const PRIVATE_NAMES = new Set(['localhost', 'localhost.localdomain', 'local', 'internal']);

/** 判断一个已经规范化（URL 解析后）的 hostname 是否指向内网或保留地址。 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (PRIVATE_NAMES.has(host)) return true;
  // 只认「保留 TLD 本身或它的子域」，且去掉前缀后必须是非空、非空白的标签。
  // 直接写 host.endsWith('.example') 会把 `xn--bcher-kva.example` 也当保留域名——
  // 那只是个普通站名，误杀会让用户没法提交。
  if (PRIVATE_TLDS.some(tld => host === tld || (host.endsWith(`.${tld}`) && host.length > tld.length + 1))) return true;

  if (!host.includes(':')) {
    const parts = ipv4ToParts(host);
    return parts !== null && isPrivateIpv4(parts);
  }

  // WHATWG URL 会把内嵌 IPv4 的 IPv6 规范化成一串十六进制分组，这里统一按分组判断。
  const [head, tail] = host.split('::');
  const leading = head ? head.split(':') : [];
  const trailing = tail ? tail.split(':') : [];
  const width = 8 - leading.length - trailing.length;
  // 分组数不合法时（:: 出现多次、总长超过 8）按内网处理：宁严勿宽。
  if (host.includes('::') && width < 0) return true;
  const groups = host.includes('::') ? [...leading, ...Array<string>(width).fill('0'), ...trailing] : leading;
  const words = groups.map(group => parseInt(group, 16));
  if (words.length !== 8 || words.some(word => !Number.isInteger(word) || word < 0 || word > 0xffff)) return true;

  // 唯一本地 fc00::/8、链路本地 fe80::/10、站点本地 fec0::/10，以及组播 ff00::/8。
  // 组播早先漏了：IPv4 侧 `first >= 224` 已经把组播挡掉，IPv6 侧没有对应分支。
  if ((words[0]! & 0xfe00) === 0xfc00 || (words[0]! & 0xffc0) === 0xfe80
    || (words[0]! & 0xffc0) === 0xfec0 || (words[0]! & 0xff00) === 0xff00) return true;
  // 未指定、回环、IPv4-mapped（::ffff:0:0/96）与 IPv4-compatible 都带内嵌 IPv4 或本身就是零地址。
  if (words.slice(0, 6).every(word => word === 0)) {
    // ::、::1 与 ::x.x.x.x：未指定地址与回环，一律拒绝。
    return true;
  }
  // IPv4-mapped `::ffff:a.b.c.d`：按内嵌的 IPv4 判断，公网地址照常放行。
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return isPrivateIpv4(wordsToIpv4(words[6]!, words[7]!));
  }
  // IPv4-translated `::ffff:0:a.b.c.d`：内嵌 IPv4 在第 6、7 组。
  // 之前漏的正是这一支：分组是 [0,0,0,0,0xffff,0,hi,lo]，上面「前 5 组全零」不成立，
  // 后面的 NAT64/6to4 分支也都不命中，于是被当成公网地址放行。
  if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0xffff && words[5] === 0) {
    return isPrivateIpv4(wordsToIpv4(words[6]!, words[7]!));
  }
  // NAT64 `64:ff9b::/96`：末尾 32 位是 IPv4。
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every(word => word === 0)) {
    return isPrivateIpv4(wordsToIpv4(words[6]!, words[7]!));
  }
  // 6to4 `2002::/16`：第 2、3 个分组嵌入 IPv4。
  if (words[0] === 0x2002) return isPrivateIpv4(wordsToIpv4(words[1]!, words[2]!));
  // 文档保留段 `2001:db8::/32`、Teredo `2001:0::/32` 与基准测试段，都不是真实站点。
  if (words[0] === 0x2001 && (words[1] === 0x0db8 || words[1] === 0)) return true;
  return false;
}
