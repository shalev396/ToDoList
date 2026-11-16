import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { demoLanguage, demoUpcomingDeadlines } from './demoData';
import {
  applyLiveStep,
  initialLiveState,
  LIVE_INTERVAL_MS,
  visibleDeadlines,
  type LiveItem,
  type LiveState,
} from './liveHero';

export interface LiveHero {
  state: LiveState;
  /** The deadlines to list now. */
  deadlines: LiveItem[];
  /** False with reduced motion: the hero is one still frame. */
  playing: boolean;
}

/**
 * Plays the hero's script: one step every LIVE_INTERVAL_MS while the tab is visible. With reduced
 * motion nothing plays and the sample stays as it is. Changing the language starts it over, so
 * the titles are never in two languages.
 */
export function useLiveHero(now: Date, language: string): LiveHero {
  const reduced = useReducedMotion();
  const lang = demoLanguage(language);
  const base = useMemo(() => demoUpcomingDeadlines(now, lang, 10), [now, lang]);
  const latest = useRef({ base, now, lang });
  useEffect(() => {
    latest.current = { base, now, lang };
  });
  const [state, setState] = useState(() => initialLiveState(base));
  const [stateLang, setStateLang] = useState(lang);

  if (stateLang !== lang) {
    setStateLang(lang);
    setState(initialLiveState(base));
  }

  useEffect(() => {
    if (reduced) {
      return undefined;
    }
    const id = window.setInterval(() => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      const { base: sample, now: current, lang: language_ } = latest.current;
      setState((previous) => applyLiveStep(previous, sample, current, language_));
    }, LIVE_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [reduced]);

  const shown = useMemo(() => visibleDeadlines(state, now), [state, now]);
  return { state, deadlines: shown, playing: !reduced };
}
