/**
 * The dashboard's half of a push: which Google Calendar operations bring the
 * calendar in line with the items in scope. Pure: items, links and the clock go in, ops come out.
 *
 * - in scope with no link: `create`; with a link whose `pushedHash` no longer matches the
 *   projection: `update`; a live link whose item is gone or out of scope: `delete`;
 * - a tombstoned link (30 days) blocks re-creation unless the item was edited after `tombstonedAt`;
 * - event ids are deterministic (`el` + the item id in base32hex), so a repeated create is
 *   idempotent; an op id carries the type, the item and the projection hash, which the commit
 *   reads back (`parseOpId`);
 * - at most `maxOps` ops per run, at most `maxCreates` creates (what is left of the daily cap).
 */
import { createHash } from 'node:crypto';

import { stableStringify } from '../sync/hash.js';

export const ORIGIN = 'todolist';
export const EVENT_ID_PREFIX = 'el';
export const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Events that ended earlier than this are not projected (the pull's full-sync window). */
export const PAST_WINDOW_DAYS = 30;

/** What the diff needs of an item (a query row, plus `editedAt`). */
export interface PushItem {
  id: string;
  title: string;
  startAt: Date | null;
  dueAt: Date | null;
  endAt: Date | null;
  allDay: boolean;
  source: { provider: string; url: string };
  /** `overlay.calendarSync === false` stops projecting. */
  calendarSync: boolean | null;
  /** The user's last edit: `max(updatedAt, overlay.editedAt)`. */
  editedAt: Date | null;
}

/** What the diff needs of a `CalendarLinks` row. */
export interface PushLink {
  itemId: string;
  calendarId: string;
  googleEventId: string;
  lastEtag: string | null;
  pushedHash: string | null;
  tombstonedAt: Date | null;
}

export interface PushConfig {
  workspaceId: string;
  /** Null: nothing can be created (updates and deletes go to the link's own calendar). */
  calendarId: string | null;
  timeZone: string;
  horizonDays: number;
  maxOps: number;
  /** What is left of the daily creation cap. */
  maxCreates: number;
  /** False when the item list may be partial (a truncated query): nothing is deleted then. */
  allowDelete: boolean;
}

export interface EventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface EventBody {
  id: string;
  summary: string;
  description: string;
  start: EventTime;
  end: EventTime;
  source?: { title: string; url: string };
  status: 'confirmed';
  extendedProperties: {
    private: { origin: typeof ORIGIN; todolistItemId: string; todolistWs: string };
  };
}

export type OpType = 'create' | 'update' | 'delete';

/** One operation for the script (applyOps_ in Code.gs). */
export interface WireOp {
  opId: string;
  type: OpType;
  calendarId: string;
  eventId: string;
  etag?: string;
  event?: EventBody;
}

export interface PlanEntry {
  type: OpType;
  itemId: string;
  title: string;
}

export interface SkippedItem {
  itemId: string;
  title: string;
  reason: 'unchanged' | 'tombstoned' | 'daily_cap' | 'no_target_calendar';
}

export interface BuildResult {
  /** At most `maxOps`: what is sent. */
  ops: WireOp[];
  /** One per planned op, those past the cap included. */
  entries: PlanEntry[];
  skipped: SkippedItem[];
  /** Everything pending, before the cap. */
  counts: { create: number; update: number; remove: number };
}

// ─── ids ────────────────────────────────────────────────────────────────────

const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';

/** `el` + base32hex of the item id (a uuid's 16 bytes; any other id as UTF-8). Chars a-v0-9. */
export function eventIdFor(itemId: string): string {
  const compact = itemId.replaceAll('-', '');
  const bytes = /^[0-9a-f]{32}$/i.test(compact)
    ? Buffer.from(compact, 'hex')
    : Buffer.from(itemId, 'utf8');
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31] ?? '';
  return `${EVENT_ID_PREFIX}${out}`;
}

export function opIdOf(type: OpType, itemId: string, hash: string): string {
  return `${type}.${itemId}.${hash}`;
}

export interface ParsedOpId {
  type: OpType;
  itemId: string;
  hash: string;
}

export function parseOpId(opId: unknown): ParsedOpId | null {
  if (typeof opId !== 'string') return null;
  const match = /^(create|update|delete)\.([0-9A-Za-z_-]{1,64})\.([0-9a-f]{16}|none)$/.exec(opId);
  if (match === null) return null;
  return { type: match[1] as OpType, itemId: match[2] ?? '', hash: match[3] ?? '' };
}

// ─── projection ─────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` of the instant in the zone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url);

/**
 * The event an item projects to, or null when it has no date. All-day items span local dates (end
 * exclusive); a due-only item is all-day on its local date, or the 15 minutes before it.
 */
export function projectEvent(
  item: PushItem,
  workspaceId: string,
  timeZone: string,
): EventBody | null {
  const anchor = item.startAt ?? item.dueAt;
  if (anchor === null) return null;
  let start: EventTime;
  let end: EventTime;
  if (item.allDay) {
    const first = localDate(anchor, timeZone);
    const last =
      item.startAt !== null && item.endAt !== null ? localDate(item.endAt, timeZone) : first;
    start = { date: first };
    end = { date: last > first ? last : addDays(first, 1) };
  } else if (item.startAt !== null) {
    const to =
      item.endAt !== null && item.endAt > item.startAt
        ? item.endAt
        : new Date(item.startAt.getTime() + FIFTEEN_MIN_MS);
    start = { dateTime: item.startAt.toISOString(), timeZone };
    end = { dateTime: to.toISOString(), timeZone };
  } else {
    start = { dateTime: new Date(anchor.getTime() - FIFTEEN_MIN_MS).toISOString(), timeZone };
    end = { dateTime: anchor.toISOString(), timeZone };
  }
  const url = item.source.url;
  return {
    id: eventIdFor(item.id),
    summary: item.title,
    description: isWebUrl(url) ? url : '',
    start,
    end,
    ...(isWebUrl(url) ? { source: { title: item.source.provider, url } } : {}),
    status: 'confirmed',
    extendedProperties: {
      private: { origin: ORIGIN, todolistItemId: item.id, todolistWs: workspaceId },
    },
  };
}

/** 16 hex characters of SHA-256 over the projected event. */
export function hashEvent(event: EventBody): string {
  return createHash('sha256').update(stableStringify(event)).digest('hex').slice(0, 16);
}

/** The instants an event covers (all-day dates at noon UTC), for the window check. */
function span(event: EventBody): { from: number; to: number } {
  const at = (time: EventTime): number =>
    time.dateTime !== undefined
      ? Date.parse(time.dateTime)
      : Date.parse(`${time.date ?? ''}T12:00:00Z`);
  return { from: at(event.start), to: at(event.end) };
}

// ─── the diff ───────────────────────────────────────────────────────────────

interface Planned {
  op: WireOp;
  entry: PlanEntry;
}

export function buildOps(
  items: readonly PushItem[],
  links: readonly PushLink[],
  cfg: PushConfig,
  now: Date,
): BuildResult {
  const live = new Map<string, PushLink>();
  const tombstoned = new Map<string, PushLink>();
  for (const link of links) {
    if (link.tombstonedAt === null) live.set(link.itemId, link);
    else if (now.getTime() - link.tombstonedAt.getTime() < TOMBSTONE_MS) {
      tombstoned.set(link.itemId, link);
    }
  }
  const windowFrom = now.getTime() - PAST_WINDOW_DAYS * DAY_MS;
  const windowTo = now.getTime() + cfg.horizonDays * DAY_MS;

  const removes: Planned[] = [];
  const updates: Planned[] = [];
  const creates: Planned[] = [];
  const skipped: SkippedItem[] = [];
  const projected = new Set<string>();

  for (const item of items) {
    if (item.calendarSync === false) continue;
    const event = projectEvent(item, cfg.workspaceId, cfg.timeZone);
    if (event === null) continue;
    const covered = span(event);
    if (covered.to < windowFrom || covered.from > windowTo) continue;
    projected.add(item.id);
    const ref = { itemId: item.id, title: item.title };
    const hash = hashEvent(event);
    const link = live.get(item.id);
    if (link !== undefined) {
      if (link.pushedHash === hash) {
        skipped.push({ ...ref, reason: 'unchanged' });
        continue;
      }
      updates.push({
        op: {
          opId: opIdOf('update', item.id, hash),
          type: 'update',
          calendarId: link.calendarId,
          eventId: link.googleEventId,
          ...(link.lastEtag === null ? {} : { etag: link.lastEtag }),
          event,
        },
        entry: { type: 'update', ...ref },
      });
      continue;
    }
    const stone = tombstoned.get(item.id)?.tombstonedAt ?? null;
    if (stone !== null && !(item.editedAt !== null && item.editedAt.getTime() > stone.getTime())) {
      skipped.push({ ...ref, reason: 'tombstoned' });
      continue;
    }
    if (cfg.calendarId === null) {
      skipped.push({ ...ref, reason: 'no_target_calendar' });
      continue;
    }
    if (creates.length >= cfg.maxCreates) {
      skipped.push({ ...ref, reason: 'daily_cap' });
      continue;
    }
    creates.push({
      op: {
        opId: opIdOf('create', item.id, hash),
        type: 'create',
        calendarId: cfg.calendarId,
        eventId: event.id,
        event,
      },
      entry: { type: 'create', ...ref },
    });
  }

  if (cfg.allowDelete) {
    const titles = new Map(items.map((item) => [item.id, item.title]));
    for (const link of live.values()) {
      if (projected.has(link.itemId)) continue;
      removes.push({
        op: {
          opId: opIdOf('delete', link.itemId, 'none'),
          type: 'delete',
          calendarId: link.calendarId,
          eventId: link.googleEventId,
        },
        entry: { type: 'delete', itemId: link.itemId, title: titles.get(link.itemId) ?? '' },
      });
    }
  }

  const all = [...removes, ...updates, ...creates];
  return {
    ops: all.slice(0, cfg.maxOps).map(({ op }) => op),
    entries: all.map(({ entry }) => entry),
    skipped,
    counts: { create: creates.length, update: updates.length, remove: removes.length },
  };
}
