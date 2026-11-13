import { describe, expect, it } from 'vitest';
import { isWeakPassword } from '../src/auth.ts';

describe('口令强度', () => {
  it.each([
    // 这几类在加强前全部放行，撞库与口令喷洒几乎不受阻。
    ['admin1234'], ['qwerty1234'], ['aaaaaaaa'], ['12345678901'],
    // 复查指出：只判「包含某个 4 连」会放过下面这些——它们确实有规律，
    // 而且是最典型的弱口令形态。
    ['welcome123'], ['P@ssw0rd!x'], ['2026zhidedeng'], ['admin1235'],
    ['abcd2345x'], ['Hunter2hunter2'], ['q1w2e3r4'], ['abcabcabc1'],
  ])('拒绝 %s', password => {
    expect(isWeakPassword(password)).toBe(true);
  });

  it('长度不足 10 位一律拒绝，不靠种类凑', () => {
    expect(isWeakPassword('Xk9#mQ2')).toBe(true);
  });

  it('拒绝包含用户名的口令', () => {
    expect(isWeakPassword('alice2026', 'alice')).toBe(true);
    expect(isWeakPassword('alice', 'alice')).toBe(true);
  });

  it.each([
    ['correct-horse-battery'], ['Tr0ub4dor&3xY'], ['薄荷味的键盘敲了九下下'],
    // 中文口令字符种类天然少，不能因为「种类 < 4」就误判。
    ['my-cat-eats-kibble-7'], ['agent-tests-correct-horse'],
  ])('放行 %s', password => {
    expect(isWeakPassword(password)).toBe(false);
  });
});
