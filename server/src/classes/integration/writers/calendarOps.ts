/**
 * The Google Calendar push's ops applied through the calendar writer (calendarApi.ts), as
 * Code.gs's applyOps_ does it: a create that exists already is patched, an update carries
 * `If-Match` (412 is a conflict), a delete of a gone event is done, ops past the deadline are
 * deferred to the next run, and an op Google gave no answer to is told apart (`no_answer`). Only GoogleCalendarIntegration's write session hands it a writer.
 */
import type { WireOp } from '../../../gcal/diff.js';
import { CalendarApiError, type CalendarWriter } from './calendarApi.js';

/** An op's outcome, in the shape the commit reads (classes/calendar/PushCommit.ts). */
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

/**
 * One op through the writer, as Code.gs's applyOps_ does it. `canCall` says whether a second call
 * (a create's adopting patch after a 409) still fits the budget; deferred otherwise.
 */
async function applyOp(
  writer: CalendarWriter,
  op: WireOp,
  canCall: () => boolean,
): Promise<OpResult> {
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
      // The id exists (adopted next run when no call fits now: the create is idempotent).
      if (!canCall()) return { opId: op.opId, ok: false, code: 'deferred' };
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
 * How an op failed: `conflict` (412), `rate_limited` (429), `no_answer` (no answer, a timeout, a
 * 5xx: it may have been made; a claimed delete is then resolved by a read), `error` otherwise.
 */
function failureCode(error: unknown): string {
  const status = statusOf(error);
  if (status === 412) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (error instanceof CalendarApiError && (status === null || status >= 500)) return 'no_answer';
  return 'error';
}

/**
 * Every op, in order, while one more call (taking up to `ceilingMs`) still ends by `deadline`
 * (epoch ms); what is left is deferred. The first op always runs, so every push makes progress.
 * Never throws.
 */
export async function applyOps(
  writer: CalendarWriter,
  ops: readonly WireOp[],
  deadline: number,
  now: () => number = Date.now,
  ceilingMs = 0,
): Promise<OpResult[]> {
  const results: OpResult[] = [];
  const fits = (): boolean => deadline - now() >= Math.max(0, ceilingMs);
  for (const op of ops) {
    const ok = fits();
    if (results.length > 0 && !ok) {
      results.push({ opId: op.opId, ok: false, code: 'deferred' });
      continue;
    }
    try {
      results.push(await applyOp(writer, op, fits));
    } catch (error) {
      results.push({ opId: op.opId, ok: false, code: failureCode(error) });
    }
  }
  return results;
}
