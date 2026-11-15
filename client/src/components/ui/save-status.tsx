import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  reservedTexts,
  saveStatusView,
  scheduleFade,
  type SaveState,
  type SaveStatusTexts,
} from './save-status-state';

export { SAVED_VISIBLE_MS, type SaveState } from './save-status-state';

/**
 * The status as drawn, for a state and whether "Saved" has faded. It always takes the room of its
 * longest text (drawn as generated content, so the page holds each text once), whatever is shown,
 * so nothing moves when it changes; it is a polite live region.
 */
function SaveStatusView({
  state,
  faded,
  texts,
  className,
}: {
  state: SaveState;
  faded: boolean;
  texts: SaveStatusTexts;
  className?: string | undefined;
}) {
  const { text, hidden } = saveStatusView(state, faded);
  return (
    <span
      data-save-status={state}
      className={cn(
        'inline-grid text-[13px] [&>*]:col-start-1 [&>*]:row-start-1',
        state === 'error' ? 'text-destructive' : 'text-muted-foreground',
        className,
      )}
    >
      <span aria-hidden="true" className="invisible grid [&>*]:col-start-1 [&>*]:row-start-1">
        {reservedTexts(texts).map((text) => (
          <span key={text} data-text={text} className="before:content-[attr(data-text)]" />
        ))}
      </span>
      <span
        role="status"
        aria-live="polite"
        className={cn(
          'transition-opacity duration-500 motion-reduce:transition-none',
          hidden ? 'opacity-0' : 'opacity-100',
        )}
      >
        {text === null ? '' : texts[text]}
      </span>
    </span>
  );
}

/**
 * "Saving…", "Saved" or "Couldn't save", beside the control that saves: SaveStatusView in the
 * reader's language, with "Saved" fading out after about 2 s.
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
    const cancel = scheduleFade(state, () => {
      setFaded(true);
    });
    return () => {
      cancel?.();
      setFaded(false);
    };
  }, [state]);

  return (
    <SaveStatusView
      state={state}
      faded={faded}
      className={className}
      texts={{
        saving: t('saveStatus.saving'),
        saved: t('saveStatus.saved'),
        error: t('saveStatus.error'),
      }}
    />
  );
}
