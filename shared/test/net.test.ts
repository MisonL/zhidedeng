import { describe, expect, it } from 'vitest';
import { isPrivateHostname } from '../src/net.ts';

describe('isPrivateHostname', () => {
  it.each([
    ['127.0.0.1', true], ['10.0.0.1', true], ['192.168.1.1', true], ['169.254.169.254', true],
    ['172.16.0.1', true], ['172.31.255.255', true], ['172.32.0.1', false], ['8.8.8.8', false],
    ['::1', true], ['[::1]', true], ['fe80::1', true], ['fc00::1', true],
    ['localhost', true], ['LOCALHOST.', true], ['.local 后缀', false],
    ['example.com', false], ['api.example.org', false],
  ])('%s -> %s', (host, expected) => {
    expect(isPrivateHostname(host)).toBe(expected);
  });

  it.each([
    // 这三种内嵌 IPv4 的写法早先全部漏网：分组是 [0,0,0,0,0xffff,0,hi,lo]，
    // 「前 5 组全零」不成立，原先的分支看不出来。
    ['::ffff:0:127.0.0.1'], ['::ffff:0:7f00:1'], ['::ffff:0:a00:1'],
    ['::ffff:127.0.0.1'], ['64:ff9b::7f00:1'],
  ])('拒绝对内网的 IPv6 嵌入形式 %s', host => {
    expect(isPrivateHostname(host)).toBe(true);
  });

  it.each([['2001:db8::1'], ['2001:0:abcd::1']])('文档保留段 %s 不算公网站点', host => {
    expect(isPrivateHostname(host)).toBe(true);
  });

  it.each([['2606:4700::1111'], ['2001:4860:4860::8888']])('真实公网 IPv6 %s 放行', host => {
    expect(isPrivateHostname(host)).toBe(false);
  });

  it('分组数异常的 IPv6 按内网处理，宁严勿宽', () => {
    expect(isPrivateHostname('1:2:3:4:5:6:7:8::9:2:3:4:5:6:7:8')).toBe(true);
  });
});
