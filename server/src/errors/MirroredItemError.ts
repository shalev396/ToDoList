import type { Provider } from '../types/domain.js';
import { AppError } from './AppError.js';

/**
 * 409: a mirrored item edited as if it were local. Mirrored items are edited at their source, so
 * the REST answer is `{message, openIn}` (controllers/items.ts) and MCP answers with the "Open in"
 * link (mcp/pipeline.ts).
 *
 * The repositories signal the same case with models/errors.ts's MirroredItemError, a storage-level
 * error that services turn into this one.
 */
export class MirroredItemError extends AppError {
  readonly openIn: { readonly provider: Provider; readonly url: string };

  constructor(provider: Provider, url: string) {
    super(409, 'This item is mirrored from its source: edit it there');
    this.name = 'MirroredItemError';
    this.openIn = Object.freeze({ provider, url });
  }
}
