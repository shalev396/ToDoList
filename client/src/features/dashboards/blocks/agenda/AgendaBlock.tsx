import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarCheck } from 'lucide-react';
import { SourceIcon } from '@/components/items/SourceIcon';
import { dateLocale, timeOfDay } from '@/components/items/format';
import { ColourDot } from '@/features/colours/ColourDot';
import { markStyle } from '@/features/colours/palette';
import { useRowColours } from '@/features/colours/useColours';
import type { ItemColour } from '@api-types/colours';
import { SourceLink } from '@/features/items/SourceLink';
import { useItemParam } from '@/features/items/useItemParam';
import { useLanguage } from '@/hooks/useLanguage';
import { BlockFrame } from '../../BlockFrame';
import { blockTitle } from '../../chrome';
import type { BlockComponentProps } from '../../registry/types';
import { displayProvider } from '../data/rows';
import { truncateText } from '../data/truncate';
import { useDataBlock } from '../data/useDataBlock';
import { splitAreas } from '../time/areas';
import type { Occurrence } from '../time/occurrences';
import { AgendaAreaHeader } from './AgendaAreaHeader';
import { AGENDA_PARTS, agendaAreas, buildAgenda } from './agendaModel';

function AgendaRow({
  occurrence,
  timeZone,
  locale,
  colour,
}: {
  occurrence: Occurrence;
  timeZone: string;
  locale: string;
  colour: ItemColour;
}) {
  const { t } = useTranslation();
  const { openItem } = useItemParam();
  const { row } = occurrence;
  const title = truncateText(row.title, 160) || t('dataBlocks.noTitle');
  const time = occurrence.allDay
    ? t('timeBlocks.agenda.allDay')
    : timeOfDay(occurrence.start, locale, timeZone);
  return (
    <li className="flex min-h-11 items-center gap-2 border-b py-1 last:border-b-0">
      <span className="w-16 shrink-0 text-[13px] text-muted-foreground tabular-nums" dir="ltr">
        {time}
      </span>
      <ColourDot colour={colour} />
      <button
        type="button"
        onClick={() => {
          openItem(row.id);
        }}
        className="min-w-0 flex-1 truncate rounded-sm text-start text-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        dir="auto"
      >
        {title}
      </button>
      <SourceIcon source={displayProvider(row.source.provider)} />
      <SourceLink source={row.source} title={title} />
    </li>
  );
}

/**
 * The agenda (H3): what is on now, what is next, later today, then tomorrow, in the workspace's
 * time zone. Built for a phone: one column, big rows.
 */
export default function AgendaBlock({ dashboard, block }: BlockComponentProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { query, rows, loadState, now, timeZone } = useDataBlock(dashboard, block);
  const title = blockTitle(block, t);
  const locale = dateLocale(language);
  const itemRows = useMemo(() => rows.map((entry) => entry.row), [rows]);
  const colourOf = useRowColours(itemRows);
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
        {AGENDA_PARTS.filter((part) => groups[part].length > 0).map((part) => {
          const row = (occurrence: Occurrence) => (
            <AgendaRow
              key={occurrence.key}
              occurrence={occurrence}
              timeZone={timeZone}
              locale={locale}
              colour={colourOf(occurrence.row.id)}
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
                        colour={colourOf(area.row.id)}
                        timeZone={timeZone}
                        locale={locale}
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
