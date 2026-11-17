import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { demoLanguage } from './demoData';
import { WeekGrid } from './demos/TimeDemo';
import { Container } from './layout';
import { summarizeWeek, weekEvents, type WeekKind } from './weeks';

const KINDS: readonly WeekKind[] = ['light', 'packed'];

/**
 * "Built for everyone": the same calendar block on two very different weeks. A switch picks a
 * light student week or a packed one (two jobs, studies and a side project); only the data changes.
 */
export function Everyone({ now, timeZone }: { now: Date; timeZone: string }) {
  const { t, i18n } = useTranslation();
  const [kind, setKind] = useState<WeekKind>('light');
  const lang = demoLanguage(i18n.language);
  const events = useMemo(() => weekEvents(kind, now, lang), [kind, now, lang]);
  const summary = summarizeWeek(events);

  return (
    <section aria-labelledby="everyone-title" className="py-[72px] lg:py-28">
      <Container className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:gap-8">
        <div className="flex flex-col lg:col-span-4">
          <h2
            id="everyone-title"
            className="max-w-[16ch] text-[1.875rem] leading-[1.1] font-semibold tracking-[-0.02em] text-balance lg:text-[2.75rem]"
          >
            {t('landing.everyone.title')}
          </h2>
          <p className="mt-5 max-w-[40ch] text-muted-foreground">{t('landing.everyone.body')}</p>
          <div
            role="group"
            aria-label={t('landing.everyone.switch')}
            className="mt-8 inline-flex w-fit max-w-full rounded-full border bg-sunken p-1"
          >
            {KINDS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={kind === option}
                onClick={() => {
                  setKind(option);
                }}
                className={cn(
                  'inline-flex min-h-10 items-center rounded-full px-4 text-sm transition-colors',
                  kind === option
                    ? 'bg-card font-medium text-foreground shadow-[0_0_0_1px_var(--border)]'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`landing.everyone.${option}.label`)}
              </button>
            ))}
          </div>
          <p className="mt-5 max-w-[40ch] text-sm text-muted-foreground" aria-live="polite">
            {t(`landing.everyone.${kind}.who`)}{' '}
            {t('landing.everyone.summary', {
              events: summary.events,
              sources: summary.sources,
              hours: summary.hours,
            })}
          </p>
        </div>
        <div className="lg:col-span-8">
          <WeekGrid
            events={events}
            now={now}
            timeZone={timeZone}
            title={t(`landing.everyone.${kind}.label`)}
            fadeIn
          />
        </div>
      </Container>
    </section>
  );
}
