import { AppError } from './AppError.js';

/** 400 `provider_coming_soon`: a provider that is listed but can't be connected yet (Moodle). */
export class ProviderComingSoonError extends AppError {
  readonly provider: string;

  constructor(provider: string) {
    super(400, `${provider} is coming soon and can't be connected yet`, {
      code: 'provider_coming_soon',
    });
    this.name = 'ProviderComingSoonError';
    this.provider = provider;
  }
}
