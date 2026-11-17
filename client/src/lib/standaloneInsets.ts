/**
 * The iPhone Home Screen app (navigator.standalone) can end its viewport above the home
 * indicator while env(safe-area-inset-bottom) still reports the indicator's height. A bar that
 * pads itself by that inset then floats above an empty band, and the whole page sits too high.
 *
 * The page draws from the top of the screen (viewport-fit=cover with a translucent status bar),
 * so whatever height the viewport lacks is missing at the bottom. watchStandaloneInsets tells the
 * CSS how much (--offscreen-bottom), and index.css takes it off the bottom inset. When the
 * viewport does reach the bottom, it is 0 and nothing changes.
 *
 * Even then the full inset (34px on a current iPhone) leaves the tabs above an empty band, so the
 * Home Screen app also caps the inset at BOTTOM_INSET_CAP_PX (--bottom-inset-cap), as iOS 26's
 * own tab bars sit. Safari tabs, desktop and Android never run this, so they keep the full inset.
 */

/** The most of the bottom inset the Home Screen app keeps: clear of the home indicator (8–13px). */
export const BOTTOM_INSET_CAP_PX = 20;

export interface ScreenFacts {
  /** screen.width and screen.height: iOS reports them in portrait whatever the orientation. */
  screenWidth: number;
  screenHeight: number;
  viewportHeight: number;
  portrait: boolean;
}

/** How many CSS pixels of the screen lie below the viewport (0 when it reaches the bottom). */
export function offscreenBottom({
  screenWidth,
  screenHeight,
  viewportHeight,
  portrait,
}: ScreenFacts): number {
  const long = Math.max(screenWidth, screenHeight);
  const short = Math.min(screenWidth, screenHeight);
  return Math.max(0, Math.round((portrait ? long : short) - viewportHeight));
}

type StandaloneNavigator = Navigator & { standalone?: boolean };

/** In the iPhone Home Screen app only: keep --offscreen-bottom up to date. */
export function watchStandaloneInsets(win: Window): void {
  if ((win.navigator as StandaloneNavigator).standalone !== true) {
    return;
  }
  win.document.documentElement.style.setProperty(
    '--bottom-inset-cap',
    `${String(BOTTOM_INSET_CAP_PX)}px`,
  );

  const apply = () => {
    // Safari before 16.4 has no screen.orientation: fall back to the viewport's shape.
    const orientation = (win.screen as Partial<Pick<Screen, 'orientation'>>).orientation;
    const portrait =
      orientation === undefined
        ? win.innerHeight >= win.innerWidth
        : orientation.type.startsWith('portrait');
    const px = offscreenBottom({
      screenWidth: win.screen.width,
      screenHeight: win.screen.height,
      viewportHeight: win.innerHeight,
      portrait,
    });
    win.document.documentElement.style.setProperty('--offscreen-bottom', `${String(px)}px`);
  };

  apply();
  win.addEventListener('resize', apply);
}
