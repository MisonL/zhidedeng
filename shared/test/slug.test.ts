import { describe, expect, it } from 'vitest';
import { httpUrl } from '../src/submission.ts';
import { feishuHostnameKey, slugifyHost, stationSlugBase, stationSlugSuffix } from '../src/slug.ts';

describe('feishuHostnameKey', () => {
  // 飞书同步、服务端认领、审核台反查、同步脚本的 normalizeUrl 都用这一个函数。
  // 任何一处口径不一致，同一个站就会被算成两条，或者下架计划漏掉它。
  it.each([
    // FQDN 绝对形式末尾的点必须去掉：`example.com.` 与 `example.com` 是同一站
    ['example.com.', 'example.com'],
    ['Example.COM.', 'example.com'],
    ['www.example.com.', 'example.com'],
    ['www.example.com', 'example.com'],
    // 多个尾点也属于同一 host
    ['example.com..', 'example.com'],
    // 只去一个前导 www，不做后缀/包含匹配
    ['wwwexample.com', 'wwwexample.com'],
    ['www.www.example.com', 'www.example.com'],
    ['a.example.com.evil.com', 'a.example.com.evil.com'],
    ['sub.a.example.com', 'sub.a.example.com'],
    // 端口不属于 hostname，但真传进来也不能被搞乱
    ['example.com:8443', 'example.com:8443'],
  ])('%s -> %s', (hostname, expected) => {
    expect(feishuHostnameKey(hostname)).toBe(expected);
  });

  it('去尾点不会把不同站点合并', () => {
    expect(feishuHostnameKey('a.example.com.')).not.toBe(feishuHostnameKey('a.example.com.evil.com'));
    expect(feishuHostnameKey('example.com.')).not.toBe(feishuHostnameKey('sub.example.com'));
  });
});

describe('slug 派生', () => {
  it('slugifyHost 把非字母数字折成连字符', () => {
    expect(slugifyHost('Example.COM')).toBe('example-com');
    expect(slugifyHost('a.b.c')).toBe('a-b-c');
  });

  it('feishuHostnameKey 归一之后，尾点写法与普通写法派生同一个 slug', () => {
    // 调用方传进来的都是归一后的身份（服务端 normalizeStationOriginKey 也去尾点），
    // 所以这里验证的是两处归一对齐，而不是派生函数自己会去尾点。
    expect(stationSlugBase(feishuHostnameKey('example.com.'))).toBe(stationSlugBase(feishuHostnameKey('example.com')));
    expect(stationSlugSuffix(feishuHostnameKey('example.com.'))).toBe(stationSlugSuffix(feishuHostnameKey('example.com')));
  });
});

describe('httpUrl 入库归一', () => {
  // 归一必须发生在写库之前，否则库里会同时存在 `x.com` 与 `x.com.` 两种写法，
  // 任何一处忘记去尾点的比较（服务端认领、同步脚本、审核台、将来新代码）都会把
  // 同一个站算成两条。schema 出口一次性覆盖投稿、同步、导入、Agent 四条入口。
  it.each([
    ['https://example.com./', 'https://example.com/'],
    // 只删尾点，不改写其它字符（大小写、编码都保留原样）；身份判定另由 hostnameOf 兜底
    ['https://Example.COM./', 'https://Example.COM/'],
    ['https://example.com./pricing', 'https://example.com/pricing'],
    ['https://www.example.com./', 'https://www.example.com/'],
  ])('%s → %s', (input, expected) => {
    expect(httpUrl.parse(input)).toBe(expected);
  });

  it('归一不重写整条地址：非 ASCII 路径不会被百分号编码撑长', async () => {
    // `url.toString()` 会把一个汉字展开成 9 个字符。一条输入 201 字符、带尾点且路径含
    // 中文的地址曾被展开成 680 字符写进库，此后所有对**库内 url** 再走 httpUrl 的地方
    // （下架、认领）都因超过 max(300) 直接 400——一条站就能打断整批审核与整条同步。
    const path = '路'.repeat(60);
    const input = `https://example.com./${path}`;
    expect(input.length).toBeLessThanOrEqual(300);
    const parsed = httpUrl.parse(input);
    expect(parsed.length).toBe(input.length - 1);
    expect(parsed).toBe(`https://example.com/${path}`);
    // 归一后的值本身必须仍然合法（长度、内网判定、协议都过）
    expect(httpUrl.safeParse(parsed).success).toBe(true);
  });

  it('不带尾点的地址原样保留', () => {
    expect(httpUrl.parse('https://example.com/pricing')).toBe('https://example.com/pricing');
  });

  it('仍然拒绝查询串、账号与内网地址', () => {
    for (const bad of ['https://example.com/?x=1', 'https://u:p@example.com/', 'http://127.0.0.1/', 'ftp://example.com/']) {
      expect(httpUrl.safeParse(bad).success).toBe(false);
    }
  });
});
