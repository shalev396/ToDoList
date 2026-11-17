/**
 * Safe-area spacing for the iPhone Home Screen app (navigator.standalone). Safari tabs, desktop
 * and Android never run this, so they keep the plain insets (index.css).
 *
 * Measured on the owner's iPhone (iOS 26, 2026-11-17):
 * - The viewport reaches the bottom of the screen, and the bottom inset is 34px. Padding all of
 *   it leaves the tabs above an empty band; padding none puts the labels into the screen's rounded
 *   corners. The app keeps at most BOTTOM_INSET_CAP_PX: clear of the corners and of the home
 *   indicator (8–13px from the bottom).
 * - iOS blurs a band under the status bar that reaches past the top inset, so the app adds
 *   TOP_INSET_EXTRA_PX below it (only when there is a top inset at all).
 * - window.innerHeight there is about 50px less than screen.height although the page fills the
 *   screen, so the screen/viewport difference says nothing about where the page ends: never use it.
 */

/** The most of the bottom inset the Home Screen app keeps. */
export const BOTTOM_INSET_CAP_PX = 20;

/** The space the Home Screen app adds under the top inset, past the status bar's blur. */
export const TOP_INSET_EXTRA_PX = 10;

type StandaloneNavigator = Navigator & { standalone?: boolean };

/** The custom properties index.css reads; empty outside the Home Screen app. */
export function standaloneInsetProperties(standalone: boolean): Record<string, string> {
  if (!standalone) {
    return {};
  }
  return {
    '--bottom-inset-cap': `${String(BOTTOM_INSET_CAP_PX)}px`,
    '--top-inset-extra': `${String(TOP_INSET_EXTRA_PX)}px`,
  };
}

/** In the iPhone Home Screen app only: set the properties above on <html>. */
export function applyStandaloneInsets(win: Window): void {
  const standalone = (win.navigator as StandaloneNavigator).standalone === true;
  for (const [name, value] of Object.entries(standaloneInsetProperties(standalone))) {
    win.document.documentElement.style.setProperty(name, value);
  }
}
