import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, LayoutPanelTop } from 'lucide-react';
import { isolateAuto } from '../time/areas';
import { chooserPlace, type ChooserPlace } from './chooserPlace';

/** A touch is followed by a synthesized click at the same spot; rows ignore it this long. */
const SETTLE_MS = 450;
/** Rows are at least this tall: a finger's target (44px), on a mouse too. */
const ROW_CLASS =
  'flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-3 text-start text-sm outline-hidden hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring';

export interface ChooserArea {
  key: string;
  title: string;
  onOpen: () => void;
}

export interface AreaChooserProps {
  /** The tap, in viewport px. */
  point: { x: number; y: number };
  /** The areas under the tap, each one a row. */
  areas: readonly ChooserArea[];
  /** "New to-do here". */
  onNew: () => void;
  onClose: () => void;
  /** The page reads right to left (Hebrew). */
  rtl: boolean;
}

/**
 * What a tap on painted time asks: a new to-do at that time, or one of the areas under it (one
 * row each). A small menu next to the tap, not under it (chooserPlace). It takes focus; the arrow
 * keys and Tab move between its rows, Enter activates, Esc and a tap outside close it. It ignores
 * the synthesized click that follows a touch, so it never opens and closes in one tap.
 */
export function AreaChooser({ point, areas, onNew, onClose, rtl }: AreaChooserProps) {
  const { t } = useTranslation();
  const menu = useRef<HTMLDivElement>(null);
  const openedAt = useRef(0);
  const returnTo = useRef<Element | null>(document.activeElement);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const [place, setPlace] = useState<ChooserPlace | null>(null);

  const settled = () => performance.now() - openedAt.current >= SETTLE_MS;
  const rows = (): HTMLButtonElement[] =>
    Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);

  // Placed once its size is known, before it is painted.
  useLayoutEffect(() => {
    const box = menu.current;
    if (box === null) {
      return;
    }
    setPlace(
      chooserPlace({
        point,
        size: { width: box.offsetWidth, height: box.offsetHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        rtl,
      }),
    );
  }, [point, rtl, areas.length]);

  useEffect(() => {
    openedAt.current = performance.now();
    rows()[0]?.focus({ preventScroll: true });
    const away = (event: Event) => {
      if (settled() && !(event.target instanceof Node && menu.current?.contains(event.target))) {
        closeRef.current();
      }
    };
    const dismiss = () => {
      if (settled()) {
        closeRef.current();
      }
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    document.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      document.removeEventListener('scroll', dismiss, true);
    };
  }, []);

  const close = (restoreFocus: boolean) => {
    onClose();
    if (restoreFocus && returnTo.current instanceof HTMLElement && returnTo.current.isConnected) {
      returnTo.current.focus({ preventScroll: true });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = rows();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'ArrowDown':
        go(at + 1);
        break;
      case 'ArrowUp':
        go(at - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(items.length - 1);
        break;
      case 'Tab':
        go(at + (event.shiftKey ? -1 : 1));
        break;
    }
  };

  const choose = (action: () => void) => () => {
    if (!settled()) {
      return;
    }
    onClose();
    action();
  };

  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={t('timeBlocks.calendar.chooser.label')}
      data-area-chooser=""
      onKeyDown={onKeyDown}
      className="fixed z-50 w-64 max-w-[calc(100vw-16px)] rounded-lg border bg-popover p-1 text-popover-foreground shadow-(--shadow-overlay)"
      // Hidden until placed (its size is measured first); never drawn at the wrong spot.
      style={
        place === null
          ? { insetInlineStart: 0, top: 0, visibility: 'hidden' }
          : { insetInlineStart: place.start, top: place.top }
      }
    >
      <button
        type="button"
        role="menuitem"
        data-chooser-new=""
        className={ROW_CLASS}
        onClick={choose(onNew)}
      >
        <CalendarPlus aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t('timeBlocks.calendar.chooser.newHere')}</span>
      </button>
      {areas.map((area) => (
        <button
          key={area.key}
          type="button"
          role="menuitem"
          data-chooser-area={area.key}
          className={ROW_CLASS}
          onClick={choose(area.onOpen)}
        >
          <LayoutPanelTop aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {t('timeBlocks.calendar.chooser.openArea', { title: isolateAuto(area.title) })}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
