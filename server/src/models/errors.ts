import type { Provider } from '../types/domain.js';

/**
 * A MongoDB-only repository (the dashboard collections, DATA.md §1) requested while DATABASE_URL
 * points at PostgreSQL. There are no Sequelize models for them.
 */
export class NotSupportedError extends Error {
  readonly collection: string;

  constructor(collection: string) {
    super(`${collection} needs MongoDB: DATABASE_URL must be a mongodb:// or mongodb+srv:// URL`);
    this.name = 'NotSupportedError';
    this.collection = collection;
  }
}

/**
 * A mirrored item edited as if it were local, as the repository signals it. Mirrored items are
 * edited at their source: services turn this into errors/MirroredItemError.ts (the API's 409
 * with the source link, BACKEND.md §4), hence `provider` and `url`. Its `name` tells the two
 * apart in logs.
 */
export class MirroredItemError extends Error {
  readonly itemId: string;
  readonly provider: Provider;
  readonly url: string;

  constructor(itemId: string, provider: Provider, url: string) {
    super(`Item ${itemId} is mirrored from ${provider}: edit it at the source`);
    this.name = 'StoredMirroredItemError';
    this.itemId = itemId;
    this.provider = provider;
    this.url = url;
  }
}
