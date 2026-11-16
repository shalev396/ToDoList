/**
 * The calendars TodoList created on one Google Calendar integration (`config.appCreatedCalendars`),
 * as an immutable value object. It owns one invariant: only `createCalendar` adds to it, so the
 * only calendars TodoList may ever delete are ones it made there.
 *
 * - `with(id)` is the record of a calendar Google just created; `without(id)` forgets a calendar
 *   that was deleted (or is gone);
 * - `keptIn(config)` is the settings-change rule: whatever list a change sends is replaced by the
 *   stored one;
 * - `ids` is what the writer is made with (its `deletableCalendars`).
 *
 * A record and a settings save that race can only lose an id, never add one: it fails safe (the
 * calendar is then never deleted by TodoList).
 */
const KEY = 'appCreatedCalendars';

export class AppCreatedCalendars {
  readonly #ids: readonly string[];

  private constructor(ids: readonly string[]) {
    this.#ids = Object.freeze([...new Set(ids)]);
    Object.freeze(this);
  }

  /** The stored list of a config (none: empty). Anything but a list of ids reads as none. */
  static of(config: Readonly<Record<string, unknown>>): AppCreatedCalendars {
    const stored = config[KEY];
    return new AppCreatedCalendars(
      Array.isArray(stored)
        ? (stored as unknown[]).filter(
            (id): id is string => typeof id === 'string' && /^\S{1,255}$/.test(id),
          )
        : [],
    );
  }

  get ids(): readonly string[] {
    return this.#ids;
  }

  get isEmpty(): boolean {
    return this.#ids.length === 0;
  }

  has(calendarId: string): boolean {
    return this.#ids.includes(calendarId);
  }

  /** With a calendar Google just created for TodoList. */
  with(calendarId: string): AppCreatedCalendars {
    return this.has(calendarId) ? this : new AppCreatedCalendars([...this.#ids, calendarId]);
  }

  /** Without a calendar that was deleted (or is gone). */
  without(calendarId: string): AppCreatedCalendars {
    return new AppCreatedCalendars(this.#ids.filter((id) => id !== calendarId));
  }

  /** `config` with this list in place of whatever it holds under the key (none when empty). */
  keptIn(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const rest = Object.fromEntries(Object.entries(config).filter(([key]) => key !== KEY));
    return this.isEmpty ? rest : { ...rest, [KEY]: [...this.#ids] };
  }

  toJSON(): string[] {
    return [...this.#ids];
  }
}
