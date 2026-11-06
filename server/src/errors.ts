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
