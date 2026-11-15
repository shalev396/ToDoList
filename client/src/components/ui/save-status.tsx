import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** How long "Saved" stays before it fades out. */
export const SAVED_VISIBLE_MS = 2000;

/**
 * "Saving…", "Saved" or "Couldn't save", beside the control that saves. It always takes the room
 * of its longest text, so nothing moves when it changes; it is a polite live region; "Saved" fades
 * out after about 2 s. An error replaces a stale "Saved" at once (the state decides, never the
 * timer).
 */
export function SaveStatus({
  state,
  className,
}: {
  state: SaveState;
  className?: string | undefined;
}) {
  const { t } = useTranslation();
  const [faded, setFaded] = useState(false);

  useEffect(() => {
    if (state !== 'saved') {
      return undefined;
    }
    const timer = setTimeout(() => {
      setFaded(true);
    }, SAVED_VISIBLE_MS);
    return () => {
      clearTimeout(timer);
      setFaded(false);
    };
  }, [state]);

  const texts = {
    saving: t('saveStatus.saving'),
    saved: t('saveStatus.saved'),
    error: t('saveStatus.error'),
  };
  const text = state === 'idle' ? '' : texts[state];
  // A faded "Saved" keeps its text while the opacity runs out (and the region is not re-read).
  const hidden = state === 'idle' || (state === 'saved' && faded);
  return (
    <span
      data-save-status={state}
      className={cn(
        'inline-grid text-[13px] [&>*]:col-start-1 [&>*]:row-start-1',
        state === 'error' ? 'text-destructive' : 'text-muted-foreground',
        className,
      )}
    >
      {/*
        The longest text sets the width, whatever is shown. Drawn as generated content, so the
        page has each text once (a search for "Saved" finds the status, not its sizer).
      */}
      <span aria-hidden="true" className="invisible grid [&>*]:col-start-1 [&>*]:row-start-1">
        <span data-text={texts.saving} className="before:content-[attr(data-text)]" />
        <span data-text={texts.saved} className="before:content-[attr(data-text)]" />
        <span data-text={texts.error} className="before:content-[attr(data-text)]" />
      </span>
      <span
        role="status"
        aria-live="polite"
        className={cn(
          'transition-opacity duration-500 motion-reduce:transition-none',
          hidden ? 'opacity-0' : 'opacity-100',
        )}
      >
        {text}
      </span>
    </span>
  );
}
