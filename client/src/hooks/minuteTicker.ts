/**
 * A clock that calls back at the start of every minute. No DOM and no React, so `node --test`
 * drives it with mock timers (minuteTicker.test.ts); `useNow` wraps it for components.
 */

/** What the ticker needs from `document`: its visibility and the change event. */
export interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

const MINUTE = 60_000;

/**
 * Calls `onTick` at each minute boundary until the returned function stops it. One timeout is
 * re-armed from the clock after every tick, so a late tick (a busy or throttled tab) never pushes
 * the next one off the boundary the way `setInterval` drifts. When `visibility` reports the page
 * visible again, it ticks at once and re-arms, so a tab coming back from the background is never
 * a minute or more behind.
 */
export function startMinuteTicker(onTick: () => void, visibility?: VisibilitySource): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    timer = setTimeout(
      () => {
        onTick();
        schedule();
      },
      MINUTE - (Date.now() % MINUTE),
    );
  };

  const onVisibilityChange = () => {
    if (visibility?.visibilityState !== 'visible') {
      return;
    }
    clearTimeout(timer);
    onTick();
    schedule();
  };

  schedule();
  visibility?.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    clearTimeout(timer);
    visibility?.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
