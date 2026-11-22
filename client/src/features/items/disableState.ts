/**
 * What the item sheet's Disable / Enable shows and sends (server classes/item/Disabled.ts): the
 * state of the item, or of the occurrence the sheet is on, and the overlay bodies its buttons
 * PATCH. Pure; unit-tested.
 *
 * - A single item: Disable, or "Disabled" and Enable.
 * - A repeating item (a time block or area series, a Google master) opened on an occurrence:
 *   Disable asks "Only this one / Every occurrence"; opened without one, Disable is for every
 *   occurrence. A series disabled as a whole is enabled as a whole.
 * - One occurrence of a Google series (its own row, `seriesOccurrence`): the same choice; its
 *   master may disable it (the whole series, or its slot).
 */
import { isSeriesRow } from '@api-types/recurrence/occurrences.ts';
import type { ItemDetail, UpdateOverlayRequestBody } from '@api-types/items.ts';

type Item = Pick<ItemDetail, 'props' | 'overlay' | 'seriesOccurrence'>;

/**
 * Whether the sheet offers Disable: anything a time view shows (an event, a time block or area, a
 * to-do or task with a start, a due date or a plan), never a travel leg (it is skipped).
 */
export function canDisable(
  item: Pick<ItemDetail, 'kind' | 'startAt' | 'dueAt' | 'props' | 'overlay'>,
): boolean {
  if (item.kind === 'travel') {
    return false;
  }
  return (
    item.kind === 'event' ||
    item.kind === 'block' ||
    item.startAt !== null ||
    item.dueAt !== null ||
    item.overlay.plannedAt !== null ||
    isSeriesRow(item)
  );
}

/** Which occurrences the disabled state is about. */
export type DisabledShape = 'item' | 'occurrence' | 'series';

export type DisableView =
  /** Nothing disabled: Disable (with the choice when `ask`). */
  | { kind: 'enabled'; ask: boolean; body: UpdateOverlayRequestBody; every: boolean }
  /** Disabled (`shape` says what): Enable. */
  | { kind: 'disabled'; shape: DisabledShape; body: UpdateOverlayRequestBody };

/** The overlay bodies of "Only this one" and "Every occurrence" (when the sheet asks). */
export interface DisableChoices {
  thisOne: UpdateOverlayRequestBody;
  every: UpdateOverlayRequestBody;
}

function sameInstant(a: string, b: Date): boolean {
  return new Date(a).getTime() === b.getTime();
}

/** What the sheet shows for `item`, on `occurrence` (its original start) when it is on one. */
export function disableView(item: Item, occurrence: Date | null): DisableView {
  const { overlay } = item;
  const exception = item.seriesOccurrence;
  if (isSeriesRow(item)) {
    if (overlay.disabled === true) {
      return { kind: 'disabled', shape: 'series', body: { disabled: false, scope: 'series' } };
    }
    if (occurrence === null) {
      return {
        kind: 'enabled',
        ask: false,
        every: true,
        body: { disabled: true, scope: 'series' },
      };
    }
    const at = occurrence.toISOString();
    if (overlay.disabledOccurrences.some((text) => sameInstant(text, occurrence))) {
      return {
        kind: 'disabled',
        shape: 'occurrence',
        body: { disabled: false, scope: 'occurrence', occurrenceStart: at },
      };
    }
    return {
      kind: 'enabled',
      ask: true,
      every: false,
      body: { disabled: true, scope: 'occurrence', occurrenceStart: at },
    };
  }
  if (exception !== undefined) {
    if (exception.disabled === 'series') {
      return { kind: 'disabled', shape: 'series', body: { disabled: false, scope: 'series' } };
    }
    if (overlay.disabled === true || exception.disabled === 'occurrence') {
      return {
        kind: 'disabled',
        shape: 'occurrence',
        body: { disabled: false, scope: 'occurrence' },
      };
    }
    return {
      kind: 'enabled',
      ask: true,
      every: false,
      body: { disabled: true, scope: 'occurrence' },
    };
  }
  return overlay.disabled === true
    ? { kind: 'disabled', shape: 'item', body: { disabled: false } }
    : { kind: 'enabled', ask: false, every: false, body: { disabled: true } };
}

/** "Only this one" and "Every occurrence", for a view that asks. */
export function disableChoices(view: Extract<DisableView, { kind: 'enabled' }>): DisableChoices {
  return { thisOne: view.body, every: { disabled: true, scope: 'series' } };
}
