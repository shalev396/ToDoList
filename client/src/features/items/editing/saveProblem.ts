/**
 * What a refused save of a mirrored item tells the member, as a pure function of the failure: ask
 * about the event's guests, list what reached the provider and what didn't, or one clear message
 * (with the provider's link where the change belongs there).
 */
import { apiErrorCode, apiErrorDetails, apiOpenIn, errorKey } from '../../../api/errors.ts';
import type { OpenIn } from '@api-types/items.ts';

export type SaveProblem =
  /** The event has other guests: ask whether to tell them, then send again. */
  | { kind: 'guests' }
  /** Part of it reached the provider (field names). */
  | { kind: 'partial'; written: string[]; refused: string[]; uncertain: string[] }
  /** One message (an i18n key that takes `source` and `owner`), and the provider's link. */
  | { kind: 'message'; key: string; fields: string[]; openIn: OpenIn | { url: string } | null };

/** The provider texts of the split edit's codes (they name the provider and its owner). */
const CODE_KEYS: Readonly<Record<string, string>> = {
  integration_not_owner: 'items.edit.errors.notOwner',
  integration_read_only: 'items.edit.errors.readOnly',
  scope_missing: 'items.edit.errors.reconnect',
  provider_writes_off: 'items.edit.errors.writesOff',
  status_not_available: 'items.edit.errors.statusNotAvailable',
  field_not_writable: 'items.edit.errors.fieldNotWritable',
  provider_item_missing: 'items.edit.errors.itemMissing',
};

export function saveProblemOf(error: unknown): SaveProblem {
  const code = apiErrorCode(error);
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
  const key = code === undefined ? undefined : CODE_KEYS[code];
  if (key !== undefined) {
    return { kind: 'message', key, fields: details?.fields ?? [], openIn: details?.openIn ?? null };
  }
  // A field edited at its source only (note, topic, container): today's 409 with `openIn`.
  const openIn = apiOpenIn(error);
  if (openIn !== null) {
    return { kind: 'message', key: 'items.edit.errors.atSource', fields: [], openIn };
  }
  return {
    kind: 'message',
    key: errorKey(error, 'items.sheet.saveError'),
    fields: [],
    openIn: null,
  };
}
