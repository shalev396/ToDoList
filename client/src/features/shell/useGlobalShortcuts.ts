import { useEffect, useRef } from 'react';
import { createShortcutMachine } from '@/features/shell/shortcuts';

interface GlobalShortcuts {
  /** ⌘K / Ctrl+K. */
  onPalette: () => void;
  /** `g` then a key, within a second: `g d` dashboard, `g w` work… */
  onGo: (key: string) => void;
  /** `[` collapses or expands the sidebar. */
  onToggleSidebar: () => void;
  /** `?` opens the Keyboard shortcuts dialog. */
  onHelp: () => void;
}

/** Typing in a field, a menu or the palette never triggers a shortcut (⌘K aside). */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.closest('input, textarea, select, [role="menu"], [role="listbox"], [cmdk-root]') !== null
  );
}

export function useGlobalShortcuts({
  onPalette,
  onGo,
  onToggleSidebar,
  onHelp,
}: GlobalShortcuts): void {
  const handlers = useRef({ onPalette, onGo, onToggleSidebar, onHelp });

  // The listener below is installed once; it always calls the latest handlers.
  useEffect(() => {
    handlers.current = { onPalette, onGo, onToggleSidebar, onHelp };
  });

  useEffect(() => {
    const machine = createShortcutMachine();
    const onKeyDown = (event: KeyboardEvent) => {
      const action = machine({
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        defaultPrevented: event.defaultPrevented,
        typing: isTypingTarget(event.target),
      });
      if (action === null) {
        return;
      }
      if (action.type === 'palette') {
        event.preventDefault();
        handlers.current.onPalette();
      } else if (action.type === 'go') {
        handlers.current.onGo(action.key);
      } else if (action.type === 'sidebar') {
        handlers.current.onToggleSidebar();
      } else {
        handlers.current.onHelp();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
