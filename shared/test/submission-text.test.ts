import { describe, expect, it } from 'vitest';
import { stationSchema, text } from '../src/submission.ts';

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

describe('站点报价的元素边界', () => {
  const station = (offers: unknown[]) => ({
    name: '示例站', description: 'd', url: 'https://example.com/', rechargeThreshold: null, paymentMethods: [], offers,
  });

  it('只写 modelSlug 与 rate 是合法的', () => {
    expect(stationSchema.safeParse(station([{ modelSlug: 'o3', rate: 0.5 }])).success).toBe(true);
  });

  it('报价里多写字段要报错，不能静默丢弃', () => {
    // 元素不 strict 时 { modelSlug, rate, inputRate } 会被解析成 { modelSlug, rate }，
    // 提交方以为 inputRate 生效了，榜上却只有 rate——这种「看起来成功了」最难查。
    for (const extra of [{ inputRate: 0.3 }, { outputRate: 0.8 }, { weight: 1 }, { rateX: 1 }]) {
      const result = stationSchema.safeParse(station([{ modelSlug: 'o3', rate: 0.5, ...extra }]));
      expect(result.success, `额外字段 ${Object.keys(extra)[0]} 应被拒绝`).toBe(false);
    }
  });

  it('报价本身的校验没有被放松', () => {
    expect(stationSchema.safeParse(station([{ modelSlug: 'o3', rate: 0 }])).success).toBe(false);
    expect(stationSchema.safeParse(station([{ modelSlug: '', rate: 1 }])).success).toBe(false);
    expect(stationSchema.safeParse(station([
      { modelSlug: 'o3', rate: 1 }, { modelSlug: 'o3', rate: 2 },
    ])).success).toBe(false);
  });
});
