import { AppError } from './AppError.js';

/**
 * 502: a change was sent to the provider and no answer came back (a timeout, a 5xx, a network
 * failure), so it may or may not have been made there. The caller checks at the provider; the
 * write is audited with `outcome: 'unknown'`.
 */
export class ProviderNoAnswerError extends AppError {
  readonly provider: string;

  /** `message` replaces the default text (a provider's own wording); the code stays. */
  constructor(provider: string, message?: string) {
    super(502, message ?? `${provider} did not answer: the change may have been made there`, {
      code: 'provider_no_answer',
    });
    this.name = 'ProviderNoAnswerError';
    this.provider = provider;
  }
}
