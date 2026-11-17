import { useEffect, useState } from 'react';
import { startMinuteTicker } from './minuteTicker';

/**
 * The current time, refreshed at the start of every minute and as soon as the tab is visible
 * again: enough for clocks and relative dates, without a render every second.
 */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(
    () =>
      startMinuteTicker(() => {
        setNow(new Date());
      }, document),
    [],
  );

  return now;
}
