import { useTranslation } from 'react-i18next';
import { ColourDot } from '@/features/colours/ColourDot';
import type { LegendEntry } from './legend';

/**
 * The names of the families on the ring (a subject or a topic each), so colour is never the only
 * cue. Each swatch is its family's Scheduled step, as topic-level marks are; the names wear the
 * text inks, never the family's colour. It flows with the page (right to left in Hebrew); only the
 * ring itself never mirrors. The caller leaves it out when the ring shows no colour.
 */
export function ClockLegend({ entries, more }: { entries: readonly LegendEntry[]; more: number }) {
  const { t } = useTranslation();
  return (
    <ul
      aria-label={t('timeBlocks.clock.legend')}
      data-clock-legend=""
      className="flex w-full min-w-0 flex-wrap justify-center gap-x-3 gap-y-1 text-xs"
    >
      {entries.map((entry) => (
        <li key={entry.key} className="flex min-w-0 max-w-full items-center gap-1.5">
          <ColourDot colour={{ family: entry.colour.family, role: 'scheduled' }} />
          <span dir="auto" className="min-w-0 truncate">
            {entry.label}
          </span>
        </li>
      ))}
      {more > 0 ? (
        <li className="text-muted-foreground">
          {t('timeBlocks.clock.moreTopics', { count: more })}
        </li>
      ) : null}
    </ul>
  );
}
