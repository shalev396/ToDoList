import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { cn } from '@/lib/utils';
import { AgentDemo } from './demos/AgentDemo';
import { DeadlinesDemo } from './demos/DeadlinesDemo';
import { PrivacyDemo } from './demos/PrivacyDemo';
import { SharingDemo } from './demos/SharingDemo';
import { Container } from './layout';

type ShowcaseKey = 'deadlines' | 'sharing' | 'agents' | 'privacy';

const KEYS: readonly ShowcaseKey[] = ['deadlines', 'sharing', 'agents', 'privacy'];

interface ShowcaseProps {
  now: Date;
  timeZone: string;
}

function stageFor(key: ShowcaseKey, { now, timeZone }: ShowcaseProps): ReactNode {
  switch (key) {
    case 'deadlines':
      return <DeadlinesDemo now={now} timeZone={timeZone} />;
    case 'sharing':
      return <SharingDemo />;
    case 'agents':
      return <AgentDemo now={now} timeZone={timeZone} />;
    case 'privacy':
      return <PrivacyDemo />;
  }
}

function stepFor(key: string): number {
  if (key === 'ArrowDown' || key === 'ArrowRight') {
    return 1;
  }
  if (key === 'ArrowUp' || key === 'ArrowLeft') {
    return -1;
  }
  return 0;
}

/**
 * One stage that rotates through four features, with a caption rail beside it. The active
 * caption fills a thin bar; when the bar ends, the next feature takes the stage. Hovering or
 * focusing anywhere in the showcase holds it, choosing a caption stops the rotation for good, and
 * with reduced motion nothing rotates. Every stage is in the page (stacked, the inactive ones
 * hidden), so the section never changes height.
 */
export function Showcase({ now, timeZone }: ShowcaseProps) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const id = useId();
  const [active, setActive] = useState(0);
  const [manual, setManual] = useState(false);
  const rotating = !reduced && !manual;

  const choose = (index: number) => {
    setActive(index);
    setManual(true);
  };

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = stepFor(event.key);
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const next = (index + step + KEYS.length) % KEYS.length;
    choose(next);
    document.getElementById(`${id}-tab-${KEYS[next] ?? 'deadlines'}`)?.focus();
  };

  return (
    <section aria-labelledby="showcase-title" className="border-t py-[72px] lg:py-28">
      <Container>
        <h2
          id="showcase-title"
          className="max-w-[20ch] text-[1.875rem] leading-[1.1] font-semibold tracking-[-0.02em] text-balance lg:text-[2.75rem]"
        >
          {t('landing.showcase.title')}
        </h2>
        <div className="group/showcase mt-10 grid grid-cols-1 gap-6 lg:mt-14 lg:grid-cols-12 lg:gap-8">
          <div className="grid grid-cols-[minmax(0,1fr)] rounded-lg border bg-sunken p-4 sm:p-8 lg:col-span-8">
            {KEYS.map((key, index) => (
              <div
                key={key}
                id={`${id}-panel-${key}`}
                role="tabpanel"
                aria-labelledby={`${id}-tab-${key}`}
                inert={index !== active}
                className={cn(
                  'col-start-1 row-start-1 mx-auto flex w-full max-w-[560px] items-center',
                  index === active ? 'landing-fade' : 'invisible',
                )}
              >
                <div className="w-full">{stageFor(key, { now, timeZone })}</div>
              </div>
            ))}
          </div>

          <div
            role="tablist"
            aria-label={t('landing.showcase.rail')}
            className="flex flex-col lg:col-span-4 lg:justify-center"
          >
            {KEYS.map((key, index) => {
              const selected = index === active;
              return (
                <button
                  key={key}
                  id={`${id}-tab-${key}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`${id}-panel-${key}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => {
                    choose(index);
                  }}
                  onKeyDown={(event) => {
                    onKeyDown(event, index);
                  }}
                  className={cn(
                    'relative flex flex-col gap-1.5 border-s-2 py-4 ps-5 pe-2 text-start transition-colors',
                    selected
                      ? 'border-border'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'text-[1.0625rem] leading-snug font-semibold',
                      selected && 'text-foreground',
                    )}
                  >
                    {t(`landing.features.${key}.title`)}
                  </span>
                  {selected ? (
                    <span className="max-w-[42ch] text-[15px] leading-relaxed text-muted-foreground">
                      {t(`landing.features.${key}.body`)}
                    </span>
                  ) : null}
                  {selected ? (
                    <span
                      key={active}
                      aria-hidden="true"
                      className={cn(
                        'absolute inset-y-0 -start-0.5 w-0.5 bg-primary',
                        rotating ? 'landing-progress' : '',
                      )}
                      onAnimationEnd={() => {
                        setActive((current) => (current + 1) % KEYS.length);
                      }}
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </Container>
    </section>
  );
}
