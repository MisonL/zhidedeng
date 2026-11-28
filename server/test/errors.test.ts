import { describe, expect, it } from 'vitest';
import { isDatabaseBusyError, isUniqueConstraintError } from '../src/errors.ts';

describe('数据库错误的识别', () => {
  it('唯一约束冲突：结构化字段与文案都认', () => {
    // node:sqlite 真实错误的形状（errcode 2067 = SQLITE_CONSTRAINT_UNIQUE）。
    expect(isUniqueConstraintError({ errcode: 2067, errstr: 'UNIQUE constraint failed', message: 'UNIQUE constraint failed: reports.targetType' })).toBe(true);
    // 主键冲突 1555。
    expect(isUniqueConstraintError({ errcode: 1555, errstr: 'PRIMARY KEY must be unique', message: 'PRIMARY KEY must be unique' })).toBe(true);
    // 只有文案（老版本/包装过的错误）也要认。
    expect(isUniqueConstraintError(new Error('UNIQUE constraint failed: users.handle'))).toBe(true);
    expect(isUniqueConstraintError(new Error('PRIMARY KEY must be unique'))).toBe(true);
  });

  it('别的错误不能被误判成唯一冲突', () => {
    expect(isUniqueConstraintError(new Error('database is locked'))).toBe(false);
    expect(isUniqueConstraintError(new Error('no such table: reports'))).toBe(false);
    // 表名里带 UNIQUE 不算——这正是原来纯字符串匹配会踩的坑。
    expect(isUniqueConstraintError(new Error('no such column: unique_flag'))).toBe(false);
    expect(isUniqueConstraintError({ errcode: 1, errstr: 'SQL logic error', message: 'SQL logic error' })).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError('UNIQUE constraint failed')).toBe(false);
  });

  it('BUSY 与唯一冲突互不影响', () => {
    expect(isDatabaseBusyError({ code: 'SQLITE_BUSY' })).toBe(true);
    expect(isDatabaseBusyError({ code: 'SQLITE_BUSY_SNAPSHOT' })).toBe(true);
    expect(isDatabaseBusyError(new Error('database is locked'))).toBe(true);
    expect(isDatabaseBusyError(new Error('UNIQUE constraint failed'))).toBe(false);
    expect(isUniqueConstraintError({ code: 'SQLITE_BUSY' })).toBe(false);
  });
});
