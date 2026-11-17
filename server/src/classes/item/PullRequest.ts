/**
 * A GitHub pull request: a TaskItem whose provider takes no write-back (GitHub's writable kinds
 * are issues only), so each of its overridable fields (title, status, due date, start, priority)
 * is kept here as an override, and its status reads GitHub's merged and review state as the sync
 * mapped it.
 */
import type { ItemData } from '../../models/definitions/Item.js';
import { Item } from './Item.js';
import { TaskItem } from './TaskItem.js';

export class PullRequest extends TaskItem {
  static {
    Item.register('pr', (data) => new PullRequest(data));
  }

  protected constructor(data: ItemData) {
    super(data);
  }

  /** What the sync kept of it at GitHub (`props.github`). */
  get #github(): Readonly<Record<string, unknown>> {
    const github = this.data.props['github'];
    return typeof github === 'object' && github !== null
      ? (github as Readonly<Record<string, unknown>>)
      : {};
  }

  /** Merged at GitHub (`props.github.merged`). */
  get merged(): boolean {
    return this.#github['merged'] === true;
  }

  /** GitHub's review decision as the sync read it (lower case), or null. */
  get reviewDecision(): string | null {
    const decision = this.#github['reviewDecision'];
    return typeof decision === 'string' ? decision : null;
  }
}
