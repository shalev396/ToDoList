/**
 * A local to-do's provider copies (H5: "Also create in"), as an immutable value object: where it
 * was created, how far each copy got, and the provider's own status of a copy once it is synced
 * (`liveStatus`). A copy is never created twice: a repeat of a request answers with its copy, and
 * a copy that may exist (pending, created, unknown) answers another request at the same
 * integration unless the user retries anyway. Pure.
 */
import { effectiveCopyStatus, type ItemCopy } from '../../models/definitions/Item.js';
import type { ItemStatus } from '../../types/domain.js';
import type { ItemCopyView } from '../../types/items.js';

/** The provider's own status of each synced copy, by `<to-do id>|<copy's external id>`. */
export type LiveStatuses = ReadonlyMap<string, ItemStatus>;

/** A copy that may exist at the provider: it answers another request there. */
function mayExist(copy: ItemCopy): boolean {
  return copy.status === 'pending' || copy.status === 'created' || copy.status === 'unknown';
}

export class Copies {
  readonly #copies: readonly Readonly<ItemCopy>[];

  private constructor(copies: readonly ItemCopy[]) {
    this.#copies = Object.freeze(copies.map((copy) => Object.freeze({ ...copy })));
    Object.freeze(this);
  }

  static of(copies: readonly ItemCopy[]): Copies {
    return new Copies(copies);
  }

  /** The key a copy's live status is kept under. */
  static liveKey(todoId: string, externalId: string): string {
    return `${todoId}|${externalId}`;
  }

  get isEmpty(): boolean {
    return this.#copies.length === 0;
  }

  /** The copy a request made (a repeat answers with it). */
  byRequest(requestId: string): ItemCopy | undefined {
    return this.#copies.find((copy) => copy.requestId === requestId);
  }

  /** The copy at this integration that may exist (pending, created or unknown). */
  activeAt(integrationId: string): ItemCopy | undefined {
    return this.#copies.find((copy) => copy.integrationId === integrationId && mayExist(copy));
  }

  /** The failed attempts at this integration (a new attempt replaces them). */
  failedAt(integrationId: string): ItemCopy[] {
    return this.#copies.filter(
      (copy) => copy.integrationId === integrationId && copy.status === 'failed',
    );
  }

  /** As the API shows them, with each synced copy's provider status for to-do `todoId`. */
  views(todoId: string, live: LiveStatuses = new Map(), now: Date = new Date()): ItemCopyView[] {
    return this.#copies.map((copy) => ({
      ...Copies.viewOf(copy, now),
      liveStatus: live.get(Copies.liveKey(todoId, copy.externalId)) ?? null,
    }));
  }

  /** One copy as the API shows it (no live status: the caller fills it). */
  static viewOf(copy: ItemCopy, now: Date = new Date()): ItemCopyView {
    return {
      integrationId: copy.integrationId,
      provider: copy.provider as ItemCopyView['provider'],
      key: copy.key,
      url: copy.url,
      status: effectiveCopyStatus(copy, now),
      liveStatus: null,
      requestId: copy.requestId,
    };
  }
}
