import type { ErrorCode, PublicError } from '../schema/types.js';

export class ViewerError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, string | number | boolean | null>;

  constructor(code: ErrorCode, message: string, options: { retryable?: boolean; details?: Record<string, string | number | boolean | null>; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ViewerError';
    this.code = code;
    this.retryable = options.retryable ?? ['TIMEOUT', 'STATE_CHANGED'].includes(code);
    this.details = options.details ?? {};
  }

  publicValue(): PublicError {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

export function asViewerError(error: unknown): ViewerError {
  return error instanceof ViewerError ? error : new ViewerError('GIT_FAILED', 'The repository could not be read.', { cause: error });
}
