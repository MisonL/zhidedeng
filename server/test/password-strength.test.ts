import { describe, expect, it } from 'vitest';
import { isWeakPassword } from '../src/auth.ts';

describe('口令强度', () => {
  it.each([
    // 这四种在加强前全部放行，撞库时几乎不受阻。
    ['admin1234'], ['qwerty1234'], ['aaaaaaaa'], ['12345678901'],
  ])('拒绝 %s', password => {
    expect(isWeakPassword(password)).toBe(true);
  });

  it('拒绝包含用户名的口令', () => {
    expect(isWeakPassword('alice2026', 'alice')).toBe(true);
    expect(isWeakPassword('alice', 'alice')).toBe(true);
  });

  it.each([['correct-horse-battery'], ['Tr0ub4dor&3xY'], ['薄荷味的键盘敲了九下']])('放行 %s', password => {
    expect(isWeakPassword(password)).toBe(false);
  });
});
