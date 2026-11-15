import { AppError } from './AppError.js';

/**
 * 409 `provider_partial_write` (207-like): a write-back made of several provider calls stopped
 * part-way. `written` reached the provider and is saved here (and audited); `refused` did not.
 * Field names only, never values.
 */
export class ProviderPartialWriteError extends AppError {
  readonly provider: string;
  readonly written: readonly string[];
  readonly refused: readonly string[];

  constructor(provider: string, written: readonly string[], refused: readonly string[]) {
    super(
      409,
      `${provider} took ${written.join(', ')} but not ${refused.join(', ')}: what it took is kept`,
      { code: 'provider_partial_write' },
    );
    this.name = 'ProviderPartialWriteError';
    this.provider = provider;
    this.written = Object.freeze([...written]);
    this.refused = Object.freeze([...refused]);
  }
}
