import { describe, expect, it } from 'vitest';
import { text } from '../src/submission.ts';

const field = text(100);
const ok = (value: string) => field.safeParse(value).success;

describe('text 字段的内容边界', () => {
  it('正常文本通过', () => {
    expect(ok('示例站')).toBe(true);
    expect(ok('多行\n正文')).toBe(true);
    expect(ok('带制表\t符')).toBe(true);
  });

  it.each([['a\u0000b'], ['s\u0007s'], ['\u0000\u0000\u0000'], ['esc\u001b[31m'], ['del\u007f']])(
    '拒绝控制字符 %j', value => {
      expect(ok(value)).toBe(false);
    },
  );

  it.each([['\u202Eevil'], ['\u202A标注'], ['\u2066隔离\u2069']])('拒绝双向控制符 %j', value => {
    // 双向覆盖符能在标题里制造「看到的是 A、实际是 B」的视觉欺骗。
    expect(ok(value)).toBe(false);
  });

  it('仍然拒绝纯空白', () => {
    expect(ok('   ')).toBe(false);
  });
});
