/**
 * The keyboard shortcuts as a pure state machine, so the chord logic is testable without a DOM.
 *
 * Letters are read from `event.code` ("KeyD"), not `event.key`. On a Hebrew (or any non-Latin)
 * layout `event.key` for that physical key is "ג", so `g` then `d` never matched. `event.key` stays
 * the fallback for the punctuation shortcuts and for layouts that report no code.
 */

export type ShortcutAction =
  | { type: 'palette' }
  | { type: 'go'; key: string }
  | { type: 'sidebar' }
  | { type: 'help' };

/** The slice of a KeyboardEvent the machine reads. */
export interface ShortcutKeyInput {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  /** True when the event came from a field, a menu or the palette. */
  typing: boolean;
}

export const CHORD_WINDOW_MS = 1000;

/** The physical letter of a key ("d"), whatever the layout; otherwise the key as typed. */
export function keyOf(input: Pick<ShortcutKeyInput, 'key' | 'code'>): string {
  const match = /^Key([A-Z])$/.exec(input.code);
  return match?.[1] !== undefined ? match[1].toLowerCase() : input.key.toLowerCase();
}

/** Returns a handler that maps each key press to an action, remembering a pending `g`. */
export function createShortcutMachine(now: () => number = Date.now) {
  let goPressedAt: number | null = null;
  return (input: ShortcutKeyInput): ShortcutAction | null => {
    const key = keyOf(input);
    if ((input.metaKey || input.ctrlKey) && !input.altKey && key === 'k') {
      goPressedAt = null;
      return { type: 'palette' };
    }
    if (input.metaKey || input.ctrlKey || input.altKey || input.defaultPrevented || input.typing) {
      return null;
    }
    if (goPressedAt !== null && now() - goPressedAt < CHORD_WINDOW_MS) {
      goPressedAt = null;
      return { type: 'go', key };
    }
    goPressedAt = null;
    if (key === 'g' && !input.shiftKey) {
      goPressedAt = now();
      return null;
    }
    if (input.key === '[' || input.code === 'BracketLeft') {
      return { type: 'sidebar' };
    }
    if (input.key === '?' || (input.shiftKey && input.code === 'Slash')) {
      return { type: 'help' };
    }
    return null;
  };
}

/** The sections of the Keyboard shortcuts dialog; labels come from i18n (`shortcuts.*`). */
export const SHORTCUT_GROUPS: readonly {
  group: 'general' | 'navigation';
  items: readonly { id: string; keys: readonly string[] }[];
}[] = [
  {
    group: 'general',
    items: [
      { id: 'palette', keys: ['mod', 'K'] },
      { id: 'sidebar', keys: ['['] },
      { id: 'help', keys: ['?'] },
    ],
  },
  {
    group: 'navigation',
    items: [
      { id: 'dashboard', keys: ['G', 'D'] },
      { id: 'work', keys: ['G', 'W'] },
      { id: 'college', keys: ['G', 'C'] },
      { id: 'personal', keys: ['G', 'P'] },
      { id: 'integrations', keys: ['G', 'I'] },
      { id: 'templates', keys: ['G', 'T'] },
      { id: 'settings', keys: ['G', 'S'] },
    ],
  },
];
