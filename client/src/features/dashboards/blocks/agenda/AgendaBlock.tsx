import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { CalendarCheck, Route } from 'lucide-react';
import { useTravelDays } from '@/api/queries/travel';
import { SourceIcon } from '@/components/items/SourceIcon';
import { dateLocale, timeOfDay } from '@/components/items/format';
import { ColourDot } from '@/features/colours/ColourDot';
import { markStyle } from '@/features/colours/palette';
import { useRowColours } from '@/features/colours/useColours';
import type { ItemColour } from '@api-types/colours';
import { SourceLink } from '@/features/items/SourceLink';
import { useItemParam } from '@/features/items/useItemParam';
import { dateInZone } from '@/features/items/zonedDate';
import { ConflictMark, LegModeIcon } from '@/features/travel/LegMark';
import { CONFLICT_EDGE, UNSET_OUTLINE, legMarksOf } from '@/features/travel/legView';
import { useLanguage } from '@/hooks/useLanguage';
import { cn } from '@/lib/utils';
import { DAY_SHEET_STATE } from '@/features/travel/travelDay';
import { dayLink, horizonOf } from '@/pages/settings/travel/travelForms';
import { BlockFrame } from '../../BlockFrame';
import { blockTitle } from '../../chrome';
import type { BlockComponentProps } from '../../registry/types';
import { displayProvider } from '../data/rows';
import { truncateText } from '../data/truncate';
import { useDataBlock } from '../data/useDataBlock';
import { splitAreas } from '../time/areas';
import { INACTIVE_TITLE, inactiveKey } from '../time/inactive';
import { InactiveTag } from '../time/InactiveTag';
import type { Occurrence } from '../time/occurrences';
import { AgendaAreaHeader } from './AgendaAreaHeader';
import { AGENDA_PARTS, agendaAreas, buildAgenda } from './agendaModel';

function AgendaRow({
  occurrence,
  timeZone,
  locale,
  colour,
  now,
}: {
  occurrence: Occurrence;
  timeZone: string;
  locale: string;
  colour: ItemColour;
  now: Date;
}) {
  const { t } = useTranslation();
  const { openItem } = useItemParam();
  const { row } = occurrence;
  // A travel leg is drawn from its props in the UI language, with its mode and flags.
  const leg = legMarksOf(t, occurrence, now);
  const title = truncateText(leg?.title ?? row.title, 160) || t('dataBlocks.noTitle');
  const time = occurrence.allDay
    ? t('timeBlocks.agenda.allDay')
    : timeOfDay(occurrence.start, locale, timeZone);
  return (
    <li
      data-inactive={occurrence.inactive ?? undefined}
      data-agenda-leg={leg === null ? undefined : leg.mode}
      data-conflict={leg === null ? undefined : String(leg.conflict)}
      data-past={leg === null ? undefined : String(leg.past)}
      data-length-unset={leg === null ? undefined : String(leg.unset)}
      className={cn(
        'flex min-h-11 items-center gap-2 py-1 shadow-[inset_0_-1px_0_var(--border)] last:shadow-none',
        // A leg that can't be made in time has a red edge; one that is over is dimmed; one whose
        // trip has no length yet is dashed.
        leg?.conflict === true && CONFLICT_EDGE,
        leg?.past === true && 'opacity-60',
        leg?.unset === true && UNSET_OUTLINE,
      )}
    >
      <span className="w-16 shrink-0 text-[13px] text-muted-foreground tabular-nums" dir="ltr">
        {time}
      </span>
      <ColourDot colour={colour} />
      {leg === null ? null : <LegModeIcon mode={leg.mode} className="text-muted-foreground" />}
      <div className="-my-1 flex min-w-0 flex-1 flex-col">
        <button
          type="button"
          // A trip with no length yet says so in its name, for anyone who can't see the dashes; a
          // cancelled or disabled one that its time is free.
          aria-label={
            leg?.unset === true
              ? `${title}. ${t('travel.leg.setLength')}`
              : occurrence.inactive === null
                ? undefined
                : `${title}. ${t(inactiveKey(occurrence.inactive))}`
          }
          onClick={() => {
            openItem(row.id, occurrence.originalStart ?? undefined);
          }}
          className="flex min-h-11 min-w-0 items-center rounded-sm text-start text-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          dir="auto"
        >
          <span className={cn('min-w-0 truncate', occurrence.inactive !== null && INACTIVE_TITLE)}>
            {title}
          </span>
        </button>
        {leg?.conflict === true ? (
          <ConflictMark className="-mt-2 mb-1 text-xs text-destructive" />
        ) : null}
      </div>
      {occurrence.inactive === null ? null : <InactiveTag inactive={occurrence.inactive} />}
      {leg === null ? (
        <>
          <SourceIcon source={displayProvider(row.source.provider)} />
          <SourceLink source={row.source} title={title} />
        </>
      ) : null}
    </li>
  );
}

/**
 * The agenda (H3): what is on now, what is next, later today, then tomorrow, in the workspace's
 * time zone. Built for a phone: one column, big rows.
 */
export default function AgendaBlock({ dashboard, block }: BlockComponentProps) {
  const { t } = useTranslation();
  const { openItem } = useItemParam();
  const location = useLocation();
  const { language } = useLanguage();
  const { query, rows, loadState, now, timeZone } = useDataBlock(dashboard, block);
  const title = blockTitle(block, t);
  const locale = dateLocale(language);
  const itemRows = useMemo(() => rows.map((entry) => entry.row), [rows]);
  const colourOf = useRowColours(itemRows);
  const changed = useChangedTravelDays(now, timeZone);
  // Areas are split off before the agenda is built; items nest under them by time.
  const groups = useMemo(() => {
    const { areas, items } = splitAreas(
      itemRows.map((row) => ({ row })),
      colourOf,
    );
    const itemModel = buildAgenda(
      items.map((entry) => entry.row),
      now,
      timeZone,
    );
    const areaModel = buildAgenda(
      areas.map((entry) => entry.row),
      now,
      timeZone,
    );
    return agendaAreas(itemModel, areaModel);
  }, [itemRows, colourOf, now, timeZone]);
  const empty = AGENDA_PARTS.every((part) => groups[part].length === 0);
  const status = loadState !== 'ready' ? loadState : empty ? 'empty' : 'ready';
  return (
    <BlockFrame
      title={title}
      status={status}
      onRetry={() => {
        void query.refetch();
      }}
      emptyIcon={<CalendarCheck />}
      emptyMessage={t('timeBlocks.agenda.empty')}
    >
      <div data-agenda className="flex flex-col gap-3">
        {changed.length === 0 ? null : (
          <ul data-agenda-travel-changed="" className="m-0 flex list-none flex-wrap gap-2 p-0">
            {changed.map((day) => (
              <li key={day.date}>
                <Link
                  to={{ pathname: location.pathname, search: dayLink(location.search, day.date) }}
                  state={DAY_SHEET_STATE}
                  data-travel-changed={day.date}
                  aria-label={t('travel.day.changedOn', { day: day.label })}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full border bg-sunken px-3 text-[13px] font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-fine:min-h-8"
                >
                  <Route aria-hidden="true" className="size-3.5 shrink-0" />
                  {t('travel.day.changed')}
                  <span className="font-normal text-muted-foreground">{day.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {AGENDA_PARTS.filter((part) => groups[part].length > 0).map((part) => {
          const row = (occurrence: Occurrence) => (
            <AgendaRow
              key={occurrence.key}
              occurrence={occurrence}
              timeZone={timeZone}
              locale={locale}
              colour={colourOf(occurrence.row.id)}
              now={now}
            />
          );
          return (
            <section key={part} data-agenda-part={part} aria-label={t(`timeBlocks.agenda.${part}`)}>
              <h3 className="pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {t(`timeBlocks.agenda.${part}`)}
              </h3>
              <ul className="m-0 list-none p-0">
                {groups[part].map(({ area, items }) =>
                  area === null ? (
                    items.map(row)
                  ) : (
                    <li
                      key={area.key}
                      data-agenda-area
                      className="my-1 rounded-md px-2"
                      style={markStyle(colourOf(area.row.id))}
                    >
                      <AgendaAreaHeader
                        title={truncateText(area.row.title, 160) || t('dataBlocks.noTitle')}
                        start={area.start}
                        end={area.end ?? area.start}
                        inactive={area.inactive}
                        colour={colourOf(area.row.id)}
                        timeZone={timeZone}
                        locale={locale}
                        onOpen={() => {
                          openItem(area.row.id, area.originalStart ?? undefined);
                        }}
                      />
                      {items.length > 0 ? (
                        <ul className="m-0 list-none p-0">{items.map(row)}</ul>
                      ) : null}
                    </li>
                  ),
                )}
              </ul>
            </section>
          );
        })}
      </div>
    </BlockFrame>
  );
}

/**
 * Today and tomorrow when some of my travel there was removed (a cancelled lecture, a skipped trip):
 * each opens that day's travel. Only editors and owners have travel, so a viewer has none. It
 * reads the same 14 days as Settings → Travel (one cached read).
 */
function useChangedTravelDays(now: Date, timeZone: string): { date: string; label: string }[] {
  const { t } = useTranslation();
  const { from, to } = horizonOf(dateInZone(now, timeZone));
  const days = useTravelDays(from, to);
  return (days.data?.days ?? []).slice(0, 2).flatMap((day, index) =>
    day.removed.length === 0
      ? []
      : [
          {
            date: day.date,
            label: index === 0 ? t('travel.days.today') : t('travel.day.tomorrow'),
          },
        ],
  );
}
