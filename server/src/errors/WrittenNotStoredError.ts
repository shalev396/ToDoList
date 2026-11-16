import { AppError } from './AppError.js';

/**
 * 409 `provider_written_not_stored`: the provider took the change (`written`, field names only),
 * and saving it here failed, so TodoList may still show the old value until the next sync. Never
 * a "couldn't be saved": the change was made there.
 */
export class WrittenNotStoredError extends AppError {
  readonly provider: string;
  readonly written: readonly string[];

  constructor(provider: string, written: readonly string[]) {
    super(409, `${provider} took the change; it shows here after the next sync`, {
      code: 'provider_written_not_stored',
    });
    this.name = 'WrittenNotStoredError';
    this.provider = provider;
    this.written = Object.freeze([...written]);
  }
}
