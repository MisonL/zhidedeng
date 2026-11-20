import { describe, expect, it } from 'vitest';
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
