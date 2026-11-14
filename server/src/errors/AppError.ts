import { ERROR_CODE_PATTERN, type ErrorCode } from '../types/errorCodes.js';

/**
 * An error whose message is safe to show the client. Anything else that reaches the error handler
 * is answered with a generic 500, so a raw provider or driver message can never leak (BACKEND §6).
 *
 * `code` is a machine code from types/errorCodes.ts that the client translates; the message stays
 * generic English and never quotes the request.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;
  readonly code: ErrorCode | undefined;

  constructor(
    statusCode: number,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown>; code?: ErrorCode } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    if (options.code !== undefined && !ERROR_CODE_PATTERN.test(options.code)) {
      throw new Error(`Invalid error code "${options.code}": use lowercase snake case`);
    }
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = options.details;
    this.code = options.code;
  }
}

/** Thrown by the response guard when a response would carry a secret (local, dev, qa). */
export class SecretLeakError extends Error {
  constructor(paths: readonly string[]) {
    super(`Response blocked: secret-shaped data at ${paths.join(', ')}`);
    this.name = 'SecretLeakError';
  }
}
