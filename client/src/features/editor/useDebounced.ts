import { useEffect, useState } from 'react';

export const PREVIEW_DEBOUNCE_MS = 300;

/** The value after it has stopped changing for `delay` ms. */
export function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);
  return settled;
}
