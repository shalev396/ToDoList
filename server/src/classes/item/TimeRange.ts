/**
 * When a calendar event happens (Schedulable), as an immutable value object: its start, its end
 * and whether it is all day. An all-day event's end is exclusive, as Google and the event's item
 * keep it (an end on the start's day reads as that one day). Pure.
 */
import { ValidationError } from '../../errors/ValidationError.js';

export class TimeRange {
  readonly #start: Date;
  readonly #end: Date;
  readonly #allDay: boolean;

  private constructor(start: Date, end: Date, allDay: boolean) {
    this.#start = new Date(start.getTime());
    this.#end = new Date(end.getTime());
    this.#allDay = allDay;
    Object.freeze(this);
  }

  /** A range that ends after it starts (all day: not before); 400 naming `endAt` otherwise. */
  static of(start: Date, end: Date, allDay: boolean): TimeRange {
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new ValidationError('startAt: Must be a valid date');
    }
    if (allDay ? end < start : end <= start) {
      throw new ValidationError('endAt: Must come after startAt');
    }
    return new TimeRange(start, end, allDay);
  }

  /** An item's stored span: null without a start; a start without an end lasts no time. */
  static from(start: Date | null, end: Date | null, allDay: boolean): TimeRange | null {
    if (start === null) return null;
    const until = end !== null && end >= start ? end : start;
    return new TimeRange(start, until, allDay);
  }

  get start(): Date {
    return new Date(this.#start.getTime());
  }

  get end(): Date {
    return new Date(this.#end.getTime());
  }

  get allDay(): boolean {
    return this.#allDay;
  }

  /** How long it lasts, in milliseconds. */
  get durationMs(): number {
    return this.#end.getTime() - this.#start.getTime();
  }

  /**
   * This range changed by an edit: a new start keeps the duration unless a new end is given, a
   * new end keeps the start; `allDay` stays as it is unless given.
   */
  changedBy(change: { start?: Date; end?: Date; allDay?: boolean }): TimeRange {
    const start = change.start ?? this.#start;
    const end =
      change.end ??
      (change.start === undefined ? this.#end : new Date(start.getTime() + this.durationMs));
    return TimeRange.of(start, end, change.allDay ?? this.#allDay);
  }

  /** Same start, end and kind. */
  equals(other: TimeRange | null): boolean {
    return (
      other !== null &&
      other.#start.getTime() === this.#start.getTime() &&
      other.#end.getTime() === this.#end.getTime() &&
      other.#allDay === this.#allDay
    );
  }

  toJSON(): { start: string; end: string; allDay: boolean } {
    return {
      start: this.#start.toISOString(),
      end: this.#end.toISOString(),
      allDay: this.#allDay,
    };
  }
}
