type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 503;

export class ApiError extends Error {
  readonly status: ErrorStatus;
  readonly code: string;

  constructor(status: ErrorStatus, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
