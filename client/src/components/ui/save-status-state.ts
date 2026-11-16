/**
 * What SaveStatus (save-status.tsx) shows, as pure functions: the text for a state, when "Saved"
 * fades, and the texts that reserve its room. Kept apart from the component so it is tested
 * without a DOM.
 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** How long "Saved" stays before it fades out. */
export const SAVED_VISIBLE_MS = 2000;

/** The three texts, in the reader's language. */
export interface SaveStatusTexts {
  saving: string;
  saved: string;
  error: string;
}

/**
 * What the status shows for `state`: its text (none when idle) and whether it is faded out. A
 * faded "Saved" keeps its text while the opacity runs out (and the live region is not re-read).
 * The state decides, never the timer: an error replaces a stale "Saved" at once.
 */
export function saveStatusView(
  state: SaveState,
  faded: boolean,
): { text: Exclude<SaveState, 'idle'> | null; hidden: boolean } {
  return {
    text: state === 'idle' ? null : state,
    hidden: state === 'idle' || (state === 'saved' && faded),
  };
}

/**
 * The texts that set the status's width: all three, whatever the state, so the status always
 * takes the room of its longest one and nothing moves when it changes.
 */
export function reservedTexts(texts: SaveStatusTexts): string[] {
  return [texts.saving, texts.saved, texts.error];
}

/**
 * Starts the fade of "Saved": `fade` runs after `ms`. Nothing for any other state. Returns what
 * cancels it (the state changed before it ran).
 */
export function scheduleFade(
  state: SaveState,
  fade: () => void,
  ms: number = SAVED_VISIBLE_MS,
): (() => void) | undefined {
  if (state !== 'saved') {
    return undefined;
  }
  const timer = setTimeout(fade, ms);
  return () => {
    clearTimeout(timer);
  };
}
