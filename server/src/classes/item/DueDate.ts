/**
 * When an item is due (HasDueDate), as an immutable value object: the instant, and whether it has
 * no time of day (an all-day due date is the day the instant falls on in the workspace's zone).
 * Two due dates are equal when they are the same instant and the same kind, so "did the due date
 * change" is one question everywhere: an edit's write-back (TaskEdit), a mirrored item's changed
 * fields (MirroredItem), and the push's projection of a due date (gcal/diff.ts). Pure.
 */
import { ValidationError } from '../../errors/ValidationError.js';

export class DueDate {
  readonly #at: Date;
  readonly #allDay: boolean;

  private constructor(at: Date, allDay: boolean) {
    this.#at = new Date(at.getTime());
    this.#allDay = allDay;
    Object.freeze(this);
  }

  /** A due date; 400 naming `dueAt` for an instant that is not a date. */
  static of(at: Date, allDay: boolean): DueDate {
    if (Number.isNaN(at.getTime())) throw new ValidationError('dueAt: Must be a valid date');
    return new DueDate(at, allDay);
  }

  /** An item's stored due date: null without an instant. */
  static from(at: Date | null, allDay: boolean): DueDate | null {
    return at === null ? null : new DueDate(at, allDay);
  }

  /** Whether two optional due dates are the same: both none, or equal. */
  static same(a: DueDate | null, b: DueDate | null): boolean {
    return a === null ? b === null : a.equals(b);
  }

  get at(): Date {
    return new Date(this.#at.getTime());
  }

  get allDay(): boolean {
    return this.#allDay;
  }

  /** Same instant, same kind. */
  equals(other: DueDate | null): boolean {
    return (
      other !== null && other.#at.getTime() === this.#at.getTime() && other.#allDay === this.#allDay
    );
  }

  toJSON(): { at: string; allDay: boolean } {
    return { at: this.#at.toISOString(), allDay: this.#allDay };
  }
}
