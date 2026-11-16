import { useSyncExternalStore } from 'react';
import { GRID_BREAKPOINT_WIDTHS, type Breakpoint } from './constants';

const QUERIES: readonly [Breakpoint, string][] = [
  ['lg', `(min-width: ${String(GRID_BREAKPOINT_WIDTHS.lg)}px)`],
  ['md', `(min-width: ${String(GRID_BREAKPOINT_WIDTHS.md)}px)`],
];

function snapshot(): Breakpoint {
  for (const [breakpoint, query] of QUERIES) {
    if (window.matchMedia(query).matches) {
      return breakpoint;
    }
  }
  return 'sm';
}

function subscribe(onChange: () => void): () => void {
  const lists = QUERIES.map(([, query]) => window.matchMedia(query));
  for (const list of lists) {
    list.addEventListener('change', onChange);
  }
  return () => {
    for (const list of lists) {
      list.removeEventListener('change', onChange);
    }
  };
}

/** The grid breakpoint of the viewport: lg from 1200px, md from 768px, sm below (constants.ts). */
export function useGridBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, snapshot, () => 'lg');
}
