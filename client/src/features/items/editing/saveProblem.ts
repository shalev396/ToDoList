/**
 * What a refused save of a mirrored item tells the member, as a pure function of the failure. The
 * rule above all: never let them believe a write to the provider happened when it didn't, or
 * didn't when it may have. So: ask about the event's guests; list what reached the provider and
 * what didn't; say plainly when the provider didn't answer (it may have made the change); else one
 * message naming the provider, with its link where the change belongs there.
 */
import {
  apiErrorCode,
  apiErrorDetails,
  apiErrorStatus,
  apiOpenIn,
  errorKey,
} from '../../../api/errors.ts';
import type { OpenIn } from '@api-types/items.ts';

export type SaveProblem =
  /** The event has other guests: ask whether to tell them, then send again. */
  | { kind: 'guests' }
  /** Part of it reached the provider (field names). TodoList's own fields were kept. */
  | { kind: 'partial'; written: string[]; refused: string[]; uncertain: string[] }
  /** No answer from the provider: the change may have been made there. */
  | { kind: 'uncertain' }
  /** One message (an i18n key that takes `source` and `owner`), and the provider's link. */
  | { kind: 'message'; key: string; fields: string[]; openIn: OpenIn | { url: string } | null };

/** The provider texts of the split edit's codes (they name the provider and its owner). */
const CODE_KEYS: Readonly<Record<string, string>> = {
  integration_not_owner: 'items.edit.errors.notOwner',
  integration_read_only: 'items.edit.errors.readOnly',
  scope_missing: 'items.edit.errors.reconnect',
  provider_writes_off: 'items.edit.errors.writesOff',
  provider_refused: 'items.edit.errors.refused',
  status_not_available: 'items.edit.errors.statusNotAvailable',
  field_not_writable: 'items.edit.errors.fieldNotWritable',
  provider_item_missing: 'items.edit.errors.itemMissing',
};

/** A gateway that gave up waiting (the provider may have answered the server meanwhile). */
const NO_ANSWER_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export function saveProblemOf(error: unknown): SaveProblem {
  const code = apiErrorCode(error);
  const status = apiErrorStatus(error);
  const details = apiErrorDetails(error);
  if (code === 'event_has_guests') {
    return { kind: 'guests' };
  }
  if (code === 'provider_partial_write') {
    return {
      kind: 'partial',
      written: details?.written ?? [],
      refused: details?.refused ?? [],
      uncertain: details?.uncertain ?? [],
    };
  }
  // Sent, and no answer came back (a timeout, a gateway, the network): it may have been made.
  if (
    code === 'provider_no_answer' ||
    status === undefined ||
    (code === undefined && NO_ANSWER_STATUSES.has(status))
  ) {
    return { kind: 'uncertain' };
  }
  const key = code === undefined ? undefined : CODE_KEYS[code];
  if (key !== undefined) {
    return { kind: 'message', key, fields: details?.fields ?? [], openIn: details?.openIn ?? null };
  }
  // A field edited at its source only (note, topic, container): today's 409 with `openIn`.
  const openIn = apiOpenIn(error);
  if (openIn !== null) {
    return { kind: 'message', key: 'items.edit.errors.atSource', fields: [], openIn };
  }
  // A provider refusal from a server that sends no code: never "changed in the meantime".
  if (code === undefined && status === 409) {
    return { kind: 'message', key: 'items.edit.errors.refused', fields: [], openIn: null };
  }
  if (code === undefined && status === 422) {
    return { kind: 'message', key: 'items.edit.errors.rejected', fields: [], openIn: null };
  }
  return {
    kind: 'message',
    key: errorKey(error, 'items.sheet.saveError'),
    fields: [],
    openIn: null,
  };
}
