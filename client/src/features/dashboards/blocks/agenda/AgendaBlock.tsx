import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarCheck } from 'lucide-react';
import { SourceDot } from '@/components/items/SourceDot';
import { dateLocale, timeOfDay } from '@/components/items/format';
import { SourceLink } from '@/features/items/SourceLink';
import { useItemParam } from '@/features/items/useItemParam';
import { useLanguage } from '@/hooks/useLanguage';
import { BlockFrame } from '../../BlockFrame';
import { blockTitle } from '../../chrome';
import type { BlockComponentProps } from '../../registry/types';
import { displayProvider } from '../data/rows';
import { truncateText } from '../data/truncate';
import { useDataBlock } from '../data/useDataBlock';
import type { Occurrence } from '../time/occurrences';
import { buildAgenda, isEmptyAgenda, type AgendaModel } from './agendaModel';

type Part = keyof AgendaModel;
const PARTS: readonly Part[] = [
  'overdue',
  'earlierToday',
  'now',
  'allDay',
  'next',
  'laterToday',
  'tomorrow',
];

function AgendaRow({
  occurrence,
  timeZone,
  locale,
}: {
  occurrence: Occurrence;
  timeZone: string;
  locale: string;
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
      <SourceDot source={displayProvider(row.source.provider)} />
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
  const model = useMemo(
    () =>
      buildAgenda(
        rows.map((entry) => entry.row),
        now,
        timeZone,
      ),
    [rows, now, timeZone],
  );
  const status = loadState !== 'ready' ? loadState : isEmptyAgenda(model) ? 'empty' : 'ready';
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
        {PARTS.filter((part) => model[part].length > 0).map((part) => (
          <section key={part} data-agenda-part={part} aria-label={t(`timeBlocks.agenda.${part}`)}>
            <h3 className="pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {t(`timeBlocks.agenda.${part}`)}
            </h3>
            <ul className="m-0 list-none p-0">
              {model[part].map((occurrence) => (
                <AgendaRow
                  key={occurrence.key}
                  occurrence={occurrence}
                  timeZone={timeZone}
                  locale={locale}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </BlockFrame>
  );
}
