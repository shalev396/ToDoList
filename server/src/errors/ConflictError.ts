import { AppError } from './AppError.js';

/**
 * A dashboard write whose `expectedVersion` is stale (BUILDER.md §8, optimistic concurrency): 409
 * with the version the dashboard is at now, so the caller can refetch and retry. Controllers answer
 * it as `409 {message, currentVersion}`.
 */
export class ConflictError extends AppError {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super(409, 'Version conflict', { details: { currentVersion } });
    this.name = 'ConflictError';
    this.currentVersion = currentVersion;
  }
}
