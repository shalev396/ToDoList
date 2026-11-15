/**
 * The Google Calendar push's ops applied through the calendar writer (calendarApi.ts), as
 * Code.gs's applyOps_ does it: a create that exists already is patched, an update carries
 * `If-Match` (412 is a conflict), a delete of a gone event is done, ops past the deadline are
 * deferred to the next run. Only GoogleCalendarIntegration's write session hands it a writer.
 */
import type { WireOp } from '../../../gcal/diff.js';
import { CalendarApiError, type CalendarWriter } from './calendarApi.js';

/** An op's outcome, in the shape the commit reads (gcal/commit.ts). */
export interface OpResult {
  opId: string;
  ok: boolean;
  code?: string;
  eventId?: string;
  etag?: string;
  updated?: string;
}

const statusOf = (error: unknown): number | null =>
  error instanceof CalendarApiError ? error.status : null;

/** One op through the writer, as Code.gs's applyOps_ does it. */
async function applyOp(writer: CalendarWriter, op: WireOp): Promise<OpResult> {
  if (op.type === 'delete') {
    await writer.remove(op.calendarId, op.eventId);
    return { opId: op.opId, ok: true };
  }
  const event = op.event;
  if (event === undefined) return { opId: op.opId, ok: false, code: 'error' };
  let written;
  if (op.type === 'create') {
    try {
      written = await writer.insert(op.calendarId, event);
    } catch (error) {
      // The deterministic id exists already (a create that was cut off, or deleted in Google).
      if (statusOf(error) !== 409) throw error;
      written = await writer.patch(op.calendarId, event.id, { ...event, status: 'confirmed' });
    }
  } else {
    written = await writer.patch(op.calendarId, op.eventId, event, op.etag);
  }
  return {
    opId: op.opId,
    ok: true,
    eventId: written.id,
    ...(written.etag === undefined ? {} : { etag: written.etag }),
    ...(written.updated === undefined ? {} : { updated: written.updated }),
  };
}

/**
 * Every op, in order, while one more call (taking up to `ceilingMs`) still ends by `deadline`
 * (epoch ms); what is left is deferred. Never throws.
 */
export async function applyOps(
  writer: CalendarWriter,
  ops: readonly WireOp[],
  deadline: number,
  now: () => number = Date.now,
  ceilingMs = 0,
): Promise<OpResult[]> {
  const results: OpResult[] = [];
  for (const op of ops) {
    const left = deadline - now();
    if (left < Math.max(0, ceilingMs)) {
      results.push({ opId: op.opId, ok: false, code: 'deferred' });
      continue;
    }
    try {
      results.push(await applyOp(writer, op));
    } catch (error) {
      const status = statusOf(error);
      results.push({
        opId: op.opId,
        ok: false,
        code: status === 412 ? 'conflict' : status === 429 ? 'rate_limited' : 'error',
      });
    }
  }
  return results;
}
