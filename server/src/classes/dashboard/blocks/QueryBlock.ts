import type { BlockCapability, DataBlock } from './contracts.js';
import { Block } from './Block.js';
import type { Query } from '../Query.js';

/**
 * A block that shows data (DataBlock): it reads an embedded query, or a saved view instead. Its
 * catalog entry requires one (requiredQuery), which the check's query rule holds it to.
 */
export abstract class QueryBlock extends Block implements DataBlock {
  static override readonly capabilities: readonly BlockCapability[] = ['data'];

  query(): Query | null {
    return this.embeddedQuery;
  }

  get savedViewId(): string | null {
    return this.json.savedViewId ?? null;
  }
}
