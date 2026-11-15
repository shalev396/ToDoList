import { AppError } from './AppError.js';

/** 404 `provider_item_missing`: the item (an issue, a task, an event) is gone at its provider. */
export class ProviderItemMissingError extends AppError {
  readonly provider: string;

  constructor(provider: string) {
    super(404, `This item no longer exists at ${provider}`, { code: 'provider_item_missing' });
    this.name = 'ProviderItemMissingError';
    this.provider = provider;
  }
}
