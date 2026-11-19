import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { parseOccurrenceParam } from './scheduled/occurrenceParam';

/** The reserved URL parameter that opens an item (urlVars.RESERVED_PARAMS). */
export const ITEM_PARAM = 'item';
/** The occurrence of a repeating item the sheet is on: its original start, in epoch ms. */
export const OCCURRENCE_PARAM = 'occurrence';

/** History state marking the entry that opened the sheet, so closing it can go back. */
interface SheetState {
  itemSheet?: boolean;
}

/**
 * `?item=<id>`: the open item, `openItem(id, occurrence?)` (a new history entry) and `closeItem()`.
 * `?occurrence=<epoch ms>` names one occurrence of a repeating item (its original start), read as
 * `occurrence` (null when absent or not a time).
 */
export function useItemParam() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const id = params.get(ITEM_PARAM);
  const occurrenceText = params.get(OCCURRENCE_PARAM);
  const occurrence = useMemo(() => parseOccurrenceParam(occurrenceText), [occurrenceText]);
  const opened = (location.state as SheetState | null)?.itemSheet === true;

  const openItem = useCallback(
    (itemId: string, at?: Date) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set(ITEM_PARAM, itemId);
          if (at === undefined || Number.isNaN(at.getTime())) {
            next.delete(OCCURRENCE_PARAM);
          } else {
            next.set(OCCURRENCE_PARAM, String(at.getTime()));
          }
          return next;
        },
        { state: { itemSheet: true } satisfies SheetState },
      );
    },
    [setParams],
  );

  /** The open sheet moves to another occurrence (null: the item as a whole), in the same entry. */
  const showOccurrence = useCallback(
    (at: Date | null) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (at === null || Number.isNaN(at.getTime())) {
            next.delete(OCCURRENCE_PARAM);
          } else {
            next.set(OCCURRENCE_PARAM, String(at.getTime()));
          }
          return next;
        },
        { replace: true, state: location.state as SheetState | null },
      );
    },
    [setParams, location.state],
  );

  // The Sheet pushed an entry, so Back closes it; closing it by hand takes that entry off.
  const closeItem = useCallback(() => {
    if (opened) {
      void navigate(-1);
      return;
    }
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(ITEM_PARAM);
        next.delete(OCCURRENCE_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [opened, navigate, setParams]);

  return {
    id: id === null || id === '' ? null : id,
    occurrence,
    openItem,
    showOccurrence,
    closeItem,
  };
}
