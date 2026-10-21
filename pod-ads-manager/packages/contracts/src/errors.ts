import type { ErrorCode } from './generated/types';

export type { ErrorCode };

/** Retry classes per code. Auth/validation are never transient. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['RATE_LIMITED', 'DATA_STALE']);

/** Business error carrying a standard code. Messages are Vietnamese and must never contain secrets or PII. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, string | number | boolean | null>;

  constructor(code: ErrorCode, message: string, details: Record<string, string | number | boolean | null> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; retryable: boolean } {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export const isDomainError = (e: unknown): e is DomainError => e instanceof DomainError;
