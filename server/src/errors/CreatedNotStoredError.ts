import { AppError } from './AppError.js';

/**
 * 409 `created_not_stored`: the provider made it (`written`, field names only), and storing it here
 * failed; it appears after the next sync. A retry with the same idempotency key makes nothing twice.
 */
export class CreatedNotStoredError extends AppError {
  readonly provider: string;
  readonly written: readonly string[];

  constructor(provider: string, written: readonly string[]) {
    super(409, `${provider} made it; it appears here after the next sync`, {
      code: 'created_not_stored',
    });
    this.name = 'CreatedNotStoredError';
    this.provider = provider;
    this.written = Object.freeze([...written]);
  }
}
