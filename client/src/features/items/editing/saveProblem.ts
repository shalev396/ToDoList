/**
 * What a refused save of a mirrored item tells the member, as a pure function of the failure. The
 * rule above all: never let them believe a write to the provider happened when it didn't, or
 * didn't when it may have. So: ask about the event's guests; list what reached the provider and
 * what didn't; say plainly when the provider didn't answer (it may have made the change), but only
 * when the save sent the provider something; else one message naming the provider, with its link
 * where the change belongs there.
 */
import {
  apiErrorCode,
  apiErrorDetails,
  apiErrorStatus,
  apiOpenIn,
  errorKey,
} from '../../../api/errors.ts';
import type { OpenIn } from '@api-types/items.ts';
import type { SaveState } from '../../../components/ui/save-status-state.ts';

export type SaveProblem =
  /** The event has other guests: ask whether to tell them, then send again. */
  | { kind: 'guests' }
  /**
   * Part of it reached the provider (field names); `kept`: the fields TodoList kept from the same
   * save, as the server says (null: a server that doesn't say).
   */
  | {
      kind: 'partial';
      written: string[];
      refused: string[];
      uncertain: string[];
      kept: string[] | null;
    }
  /** The save sent the provider something and no answer came: it may have been made there. */
  | { kind: 'uncertain' }
  /** A save of TodoList's own fields lost its answer: it may or may not be stored. */
  | { kind: 'unconfirmed' }
  /** One message (an i18n key that takes `source` and `owner`), and the provider's link. */
  | { kind: 'message'; key: string; fields: string[]; openIn: OpenIn | { url: string } | null };

/** The provider texts of the split edit's codes (they name the provider and its owner). */
const CODE_KEYS: Readonly<Record<string, string>> = {
  integration_not_owner: 'items.edit.errors.notOwner',
  integration_read_only: 'items.edit.errors.readOnly',
  scope_missing: 'items.edit.errors.reconnect',
  provider_writes_off: 'items.edit.errors.writesOff',
  provider_refused: 'items.edit.errors.refused',
  provider_unreachable: 'items.edit.errors.unreachable',
  provider_written_not_stored: 'items.edit.errors.writtenNotStored',
  status_not_available: 'items.edit.errors.statusNotAvailable',
  field_not_writable: 'items.edit.errors.fieldNotWritable',
  provider_item_missing: 'items.edit.errors.itemMissing',
};

/** A gateway that gave up waiting (the provider may have answered the server meanwhile). */
const NO_ANSWER_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * Whether the server answered (a code, or a 4xx): only then is "not kept in TodoList" known. A
 * gateway's 5xx or no response leaves it open (the server may have stored it after the gateway
 * gave up).
 */
export function serverAnswered(error: unknown): boolean {
  const status = apiErrorStatus(error);
  return apiErrorCode(error) !== undefined || (status !== undefined && status < 500);
}

/**
 * The problem of a failed save. `sentToProvider`: the save carried a provider field (without one
 * no provider request was possible, so a lost answer is TodoList's own, never the provider's).
 */
export function saveProblemOf(error: unknown, sentToProvider = true): SaveProblem {
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
      kept: details?.kept ?? null,
    };
  }
  // A bare 500 to a save that sent the provider something: the server may have failed after the
  // provider took it, so it may have been made there.
  if (code === undefined && status === 500 && sentToProvider) {
    return { kind: 'uncertain' };
  }
  // Sent, and no answer came back (a timeout, a gateway, the network): it may have been made.
  if (
    code === 'provider_no_answer' ||
    status === undefined ||
    (code === undefined && NO_ANSWER_STATUSES.has(status))
  ) {
    return code === undefined && !sentToProvider ? { kind: 'unconfirmed' } : { kind: 'uncertain' };
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

/**
 * The SaveStatus beside a save: "Couldn't save" only where nothing was saved. A partial write, an
 * unanswered or unconfirmed one, and one the provider took but TodoList couldn't store say
 * themselves what happened; a flat "Couldn't save" beside them would be untrue.
 */
export function saveStateOf(
  pending: boolean,
  problem: SaveProblem | null,
  saved: boolean,
): SaveState {
  if (pending) {
    return 'saving';
  }
  if (problem !== null) {
    return problem.kind === 'message' && problem.key !== 'items.edit.errors.writtenNotStored'
      ? 'error'
      : 'idle';
  }
  return saved ? 'saved' : 'idle';
}
