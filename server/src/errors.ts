type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 503;

export class ApiError extends Error {
  readonly status: ErrorStatus;
  readonly code: string;
  // 附加在错误响应 error 对象里的字段，例如 MODEL_IN_USE 的 stationCount。
  readonly details?: Record<string, unknown>;

  constructor(status: ErrorStatus, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * 唯一约束冲突。
 *
 * 原来各处用 `String(error.message).includes('UNIQUE')` 判断，问题有两个：
 * - `node:sqlite` 的错误对象带 `code`（`ERR_SQLITE_ERROR`）和 `errcode`/`errstr`，
 *   但**文案不是稳定的 API**，换版本/换语言环境就可能变；
 * - 全表扫描式的字符串匹配会把「表名里含 UNIQUE 的普通错误」也算进来。
 *
 * 这里同时看结构化字段和 message，任一命中即可，向后兼容。
 */
export function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown };
  // SQLITE_CONSTRAINT_UNIQUE = 2067；SQLITE_CONSTRAINT_PRIMARYKEY = 1555。
  if (candidate.errcode === 2067 || candidate.errcode === 1555) return true;
  const errstr = typeof candidate.errstr === 'string' ? candidate.errstr : '';
  if (errstr === 'UNIQUE constraint failed' || errstr === 'PRIMARY KEY must be unique') return true;
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return /\bUNIQUE constraint failed\b|\bPRIMARY KEY must be unique\b/.test(message);
}

export function isDatabaseBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return code === 'SQLITE_BUSY' || code === 'ERR_SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_')
    || /\bdatabase (?:table )?is locked\b/i.test(message);
}
