/**
 * "Planned for": the item's own plan, `YYYY-MM-DD` (a day) or `YYYY-MM-DDTHH:mm` (a day and a
 * time), in the workspace's local time. A time without a day is not a plan.
 */
export interface PlannedParts {
  /** `YYYY-MM-DD`, or '' for none. */
  date: string;
  /** `HH:mm`, or '' for none. */
  time: string;
}

/** The years a plan may name (the server refuses others). */
export const PLANNED_MIN_YEAR = 1970;
export const PLANNED_MAX_YEAR = 2999;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isRealDate(value: string): boolean {
  const match = DATE.exec(value);
  if (match === null) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < PLANNED_MIN_YEAR || year > PLANNED_MAX_YEAR) {
    return false;
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/** Whether `value` is a whole `HH:mm`. */
export function isPlannedTime(value: string): boolean {
  return TIME.test(value);
}

/**
 * Whether a picked value can be saved without waiting for blur: a whole real day (1970-2999), and a
 * time that is empty or whole. A partial or out-of-range value waits, and is never sent.
 */
export function isCommittable({ date, time }: PlannedParts): boolean {
  return isRealDate(date) && (time === '' || TIME.test(time));
}

/** The day and the time of a stored value; empty parts for none or anything unreadable. */
export function parsePlannedAt(value: string | null | undefined): PlannedParts {
  if (value === null || value === undefined) {
    return { date: '', time: '' };
  }
  const [date = '', time = ''] = value.split('T');
  if (!isRealDate(date)) {
    return { date: '', time: '' };
  }
  return { date, time: TIME.test(time) ? time : '' };
}

/** The value to store; null clears it (no day, or a day that is not real). */
export function formatPlannedAt({ date, time }: PlannedParts): string | null {
  if (!isRealDate(date)) {
    return null;
  }
  return TIME.test(time) ? `${date}T${time}` : date;
}

/** What a date or time input tells its commit policy. */
export type FieldEvent =
  | { type: 'pointerdown' }
  | { type: 'keydown'; key: string }
  /** The value changed; `focused`: the input still has the focus. */
  | { type: 'change'; focused: boolean }
  | { type: 'blur' };

/** What to do with the draft: save it, put the saved value back, or wait. */
export type FieldAction = 'commit' | 'reset' | null;

/**
 * When a date or time input's draft is saved. Chromium fires a plain `Event` (no `inputType`) for
 * every typed segment, exactly as for a pick, so the event can't tell typing from picking. So:
 * - blur and Enter save; Escape puts the saved value back;
 * - a change saves at once only when it is a pick: it follows a press of the pointer on the input
 *   with no key pressed since (the picker's button, or a tap that opened a phone's picker), or the
 *   input has lost the focus (a picker that took it, a script);
 * - any other change (typing, arrow keys) waits for blur or Enter, so typing over a whole date
 *   never saves its segments one by one.
 * The caller still checks that the draft is whole (isCommittable) before saving a pick.
 */
export function createCommitPolicy() {
  let pressed = false;
  return {
    handle(event: FieldEvent): FieldAction {
      switch (event.type) {
        case 'pointerdown':
          pressed = true;
          return null;
        case 'keydown':
          pressed = false;
          if (event.key === 'Enter') {
            return 'commit';
          }
          return event.key === 'Escape' ? 'reset' : null;
        case 'change':
          return pressed || !event.focused ? 'commit' : null;
        case 'blur':
          pressed = false;
          return 'commit';
      }
    },
  };
}

/**
 * Sends values one at a time and lets the latest win: a value pushed while another is in flight
 * waits (replacing any older waiting one) and is sent when the in-flight one settles, so the newest
 * value is always the one stored. A failed send does not stop the queue.
 */
export function createLatestWins<T>(initialSend: (value: T) => Promise<unknown>) {
  let send = initialSend;
  let busy = false;
  let waiting: { value: T } | null = null;
  const drain = async (first: T): Promise<void> => {
    busy = true;
    let current: { value: T } | null = { value: first };
    while (current !== null) {
      try {
        await send(current.value);
      } catch {
        // `send` reports its own failures; the next value still goes.
      }
      current = waiting;
      waiting = null;
    }
    busy = false;
  };
  return {
    push(value: T): void {
      if (busy) {
        waiting = { value };
      } else {
        void drain(value);
      }
    },
    /** Replaces how values are sent (the next send uses it). */
    use(next: (value: T) => Promise<unknown>): void {
      send = next;
    },
    /** Whether a send is in flight. */
    isBusy: () => busy,
  };
}
