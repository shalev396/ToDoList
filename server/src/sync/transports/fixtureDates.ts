/**
 * Relative dates for fixture files, so demo data is always "overdue / today / this week" no matter
 * when it is replayed. A fixture body may contain, as a whole JSON string value:
 *
 *   "{{date:+2d}}"            → "2026-11-14"                 (local calendar date)
 *   "{{datetime:+0d@14:00}}"  → "2026-11-12T12:00:00.000Z"   (ISO instant of a local time)
 *   "{{epoch:-3d@09:30}}"     → 1794209400                   (seconds, as a JSON number)
 *   "{{epochms:+1w}}"         → 1795508100000                (milliseconds, as a JSON number)
 *
 * Offsets are a sequence of [+-]N with unit d (days), w (weeks), h (hours) or m (minutes),
 * optionally followed by @HH:MM, which sets the local wall-clock time in `timeZone` on the
 * resulting day. Without @, the time of `now` is kept.
 */

const TOKEN = /"\{\{(date|datetime|epoch|epochms):([^"}]+)\}\}"/g;
const PART = /([+-])(\d+)([dwhm])/g;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

/** The UTC instant whose wall-clock time in `timeZone` is the given local date and time. */
export function zonedTime(parts: LocalParts, timeZone: string): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const seen = localParts(new Date(guess), timeZone);
    const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    const delta = target - seenUtc;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

/** Applies an offset like `+2d@14:00` to `now` in `timeZone`. Throws on a malformed offset. */
export function resolveOffset(spec: string, now: Date, timeZone: string): Date {
  const [offsets = '', clock] = spec.split('@');
  if (!/^([+-]\d+[dwhm])+$/.test(offsets)) throw new Error(`Bad fixture date offset "${spec}"`);
  let instant = now.getTime();
  let dayShift = 0;
  for (const match of offsets.matchAll(PART)) {
    const sign = match[1] === '-' ? -1 : 1;
    const amount = sign * Number(match[2]);
    const unit = match[3];
    if (unit === 'd') dayShift += amount;
    else if (unit === 'w') dayShift += amount * 7;
    else if (unit === 'h') instant += amount * 3_600_000;
    else instant += amount * 60_000;
  }
  const base = localParts(new Date(instant), timeZone);
  // Day arithmetic on the local calendar (DST-safe), then the wall-clock time.
  const day = new Date(Date.UTC(base.year, base.month - 1, base.day + dayShift));
  let hour = base.hour;
  let minute = base.minute;
  if (clock !== undefined) {
    const parsed = /^(\d{2}):(\d{2})$/.exec(clock);
    if (parsed === null) throw new Error(`Bad fixture time "${spec}"`);
    hour = Number(parsed[1]);
    minute = Number(parsed[2]);
  }
  return zonedTime(
    {
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
      day: day.getUTCDate(),
      hour,
      minute,
    },
    timeZone,
  );
}

/** Replaces every date token in a JSON text. Epoch tokens become bare JSON numbers. */
export function resolveFixtureDates(json: string, now: Date, timeZone: string): string {
  return json.replace(TOKEN, (_token, kind: string, spec: string) => {
    const instant = resolveOffset(spec, now, timeZone);
    if (kind === 'epoch') return String(Math.floor(instant.getTime() / 1000));
    if (kind === 'epochms') return String(instant.getTime());
    if (kind === 'date') {
      const local = localParts(instant, timeZone);
      return JSON.stringify(
        `${String(local.year)}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`,
      );
    }
    return JSON.stringify(instant.toISOString());
  });
}
