import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ctaVariants } from '@/components/shared/cta-variants';
import { DeadlineRow } from '@/components/items/DeadlineRow';
import { SourceDot } from '@/components/items/SourceDot';
import { SourceLegend } from '@/components/items/SourceLegend';
import { calendarDaysFrom, dateLocale, longDate, timeOfDay } from '@/components/items/format';
import { ClockRing } from '@/features/dashboards/blocks/clock/ClockRing';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import { clockLabels, dayStatus } from './clockLabels';
import { demoDayEvents, demoLanguage } from './demoData';
import { Block, BlockHeader, Container } from './layout';
import { useLiveHero, type LiveHero } from './useLiveHero';
import { cn } from '@/lib/utils';
import { SOURCE_STYLES, sourceNameKey } from '@/components/items/sources';

interface HeroProps {
  now: Date;
  timeZone: string;
  live: LiveHero;
}

/** What the last step did, as one line a screen reader announces politely. */
function LiveStatus({ live }: { live: LiveHero }) {
  const { t } = useTranslation();
  const last = live.state.last;
  const message = last
    ? t(`landing.live.${last.kind}`, { source: t(sourceNameKey(last.source)), title: last.title })
    : t('landing.live.idle');

  return (
    <p
      role="status"
      aria-live="polite"
      className="flex min-h-9 items-center gap-2.5 rounded-full border bg-card ps-3.5 pe-4 text-[13px]"
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-2 shrink-0 rounded-full',
          last ? SOURCE_STYLES[last.source].bg : 'bg-muted-foreground',
          live.playing && 'landing-live-dot',
        )}
      />
      <span className="min-w-0 truncate" key={live.state.step}>
        {message}
      </span>
    </p>
  );
}

function TodayBlock({ now, timeZone, live }: HeroProps) {
  const { t, i18n } = useTranslation();
  const locale = dateLocale(i18n.language);
  const lang = demoLanguage(i18n.language);
  const sample = useMemo(() => demoDayEvents(now, lang), [now, lang]);
  const events = useMemo(() => [...sample, ...live.state.events], [sample, live.state.events]);
  const emphasized = live.state.events.find((event) => event.fresh)?.id;
  const isToday = (date: Date) => calendarDaysFrom(now, date, timeZone) === 0;
  const labels = clockLabels(t, events, now, locale, timeZone, isToday);
  const { current, next } = dayStatus(events, now);
  const time = (date: Date) => timeOfDay(date, locale, timeZone);
  const ringSources = events.filter((event) => isToday(event.start)).map((event) => event.source);

  return (
    <Block>
      <BlockHeader title={t('landing.demo.today')} aside={longDate(now, locale, timeZone)} />
      <div className="flex justify-center px-4 pt-3 pb-5">
        <ClockRing
          events={events}
          now={now}
          timeZone={timeZone}
          size={300}
          labels={labels}
          animateIn
          emphasize={emphasized}
        />
      </div>
      <dl className="mx-4 border-t text-sm">
        {current ? (
          <div className="flex min-h-11 items-center gap-3 border-b">
            <dt className="w-14 shrink-0 text-[13px] text-muted-foreground">
              {t('landing.demo.now')}
            </dt>
            <dd className="flex min-w-0 flex-1 items-center gap-2">
              <SourceDot source={current.source} />
              <span className="truncate">{current.title}</span>
              <span className="ms-auto shrink-0 text-[13px] text-muted-foreground tabular-nums">
                {t('landing.demo.until', { time: time(current.end) })}
              </span>
            </dd>
          </div>
        ) : null}
        <div className="flex min-h-11 items-center gap-3">
          <dt className="w-14 shrink-0 text-[13px] text-muted-foreground">
            {t('landing.demo.next')}
          </dt>
          <dd className="flex min-w-0 flex-1 items-center gap-2">
            {next ? (
              <>
                <SourceDot source={next.source} />
                <span className="truncate">{next.title}</span>
                <span className="ms-auto shrink-0 text-[13px] text-muted-foreground tabular-nums">
                  {isToday(next.start)
                    ? time(next.start)
                    : t('landing.demo.tomorrowAt', { time: time(next.start) })}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">{t('landing.demo.nothingNext')}</span>
            )}
          </dd>
        </div>
      </dl>
      <SourceLegend
        sources={ringSources}
        label={t('landing.demo.legend')}
        className="justify-center border-t px-4 py-3"
      />
    </Block>
  );
}

function DeadlinesBlock({ now, timeZone, live }: HeroProps) {
  const { t } = useTranslation();
  const deadlines = live.deadlines;
  const fresh = live.state.last?.kind === 'deadline' ? live.state.last.ref : null;

  return (
    <Block>
      <BlockHeader title={t('landing.demo.deadlines')} aside={t('landing.demo.nextSevenDays')} />
      <ul className="divide-y border-t px-4">
        {deadlines.map((deadline) => (
          <li key={deadline.id} className={cn(deadline.id === fresh && 'landing-row-fresh')}>
            <DeadlineRow
              title={deadline.title}
              context={deadline.context}
              source={deadline.source}
              due={deadline.due}
              now={now}
              timeZone={timeZone}
              showSource
              done={deadline.done}
            />
          </li>
        ))}
      </ul>
    </Block>
  );
}

/** Headline and the two calls to action, beside a live slice of the dashboard. */
export function LandingHero({ now, timeZone }: Omit<HeroProps, 'live'>) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const live = useLiveHero(now, language);

  return (
    <section aria-labelledby="hero-title">
      <Container className="grid grid-cols-1 gap-12 pt-12 pb-[72px] lg:grid-cols-12 lg:gap-8 lg:pt-16 lg:pb-24">
        <div className="flex flex-col items-center text-center lg:col-span-6 lg:items-start lg:justify-center lg:text-start">
          <h1
            id="hero-title"
            className="max-w-[13ch] text-[2.75rem] leading-[1.05] font-semibold tracking-[-0.02em] text-balance lg:text-[4rem]"
          >
            {t('landing.hero.title')}
          </h1>
          <p className="mt-6 max-w-[48ch] text-lg leading-relaxed text-muted-foreground lg:text-[1.3125rem]">
            {t('landing.hero.lead')}
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
            <Link to={pathTo(ROUTES.AUTH.SIGNUP, language)} className={ctaVariants()}>
              {t('landing.hero.cta')}
            </Link>
            <Link
              to={pathTo(ROUTES.AUTH.LOGIN, language)}
              className={ctaVariants({ tone: 'quiet' })}
            >
              {t('landing.hero.login')}
            </Link>
          </div>
          <p className="mt-4 text-[13px] text-muted-foreground">{t('landing.hero.note')}</p>
        </div>
        <div className="mx-auto flex w-full max-w-[440px] flex-col gap-4 lg:col-span-5 lg:col-start-8 lg:max-w-none">
          <LiveStatus live={live} />
          <TodayBlock now={now} timeZone={timeZone} live={live} />
          <DeadlinesBlock now={now} timeZone={timeZone} live={live} />
        </div>
      </Container>
    </section>
  );
}
