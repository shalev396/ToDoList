import { AppError } from './AppError.js';

/**
 * 409 `provider_partial_write` (207-like): a write-back made of several provider calls stopped
 * part-way. `written` reached the provider and is saved here (and audited); `refused` did not;
 * `uncertain` was sent and got no answer (a timeout, a 5xx), so it may or may not have been made
 * there. Field names only, never values.
 */
export class ProviderPartialWriteError extends AppError {
  readonly provider: string;
  readonly written: readonly string[];
  readonly refused: readonly string[];
  readonly uncertain: readonly string[];
  /** The override fields kept in TodoList from the same edit (set by the item once it knows). */
  kept: readonly string[] = [];

  constructor(
    provider: string,
    written: readonly string[],
    refused: readonly string[],
    uncertain: readonly string[] = [],
  ) {
    const left =
      uncertain.length === 0
        ? `but not ${refused.join(', ')}`
        : `and may or may not have taken ${uncertain.join(', ')}`;
    super(409, `${provider} took ${written.join(', ')} ${left}: what it took is kept`, {
      code: 'provider_partial_write',
    });
    this.name = 'ProviderPartialWriteError';
    this.provider = provider;
    this.written = Object.freeze([...written]);
    this.refused = Object.freeze([...refused]);
    this.uncertain = Object.freeze([...uncertain]);
  }
}
