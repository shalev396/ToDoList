import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

/** The reserved URL parameter that opens an item (urlVars.RESERVED_PARAMS). */
export const ITEM_PARAM = 'item';

/** History state marking the entry that opened the sheet, so closing it can go back. */
interface SheetState {
  itemSheet?: boolean;
}

/** `?item=<id>`: the open item, `openItem(id)` (a new history entry) and `closeItem()`. */
export function useItemParam() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const id = params.get(ITEM_PARAM);
  const opened = (location.state as SheetState | null)?.itemSheet === true;

  const openItem = useCallback(
    (itemId: string) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set(ITEM_PARAM, itemId);
          return next;
        },
        { state: { itemSheet: true } satisfies SheetState },
      );
    },
    [setParams],
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
        return next;
      },
      { replace: true },
    );
  }, [opened, navigate, setParams]);

  return { id: id === null || id === '' ? null : id, openItem, closeItem };
}
