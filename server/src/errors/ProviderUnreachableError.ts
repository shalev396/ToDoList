import { AppError } from './AppError.js';

/**
 * 502: the provider could not be reached before anything was sent (a read before the write, or
 * a request the network guard or the allow-list stopped), so nothing was changed there. The
 * caller may simply try again.
 */
export class ProviderUnreachableError extends AppError {
  readonly provider: string;

  constructor(provider: string) {
    super(502, `${provider} could not be reached. Try again in a moment.`, {
      code: 'provider_unreachable',
    });
    this.name = 'ProviderUnreachableError';
    this.provider = provider;
  }
}
