import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DeadlineRow } from '@/components/items/DeadlineRow';
import { demoDeadlines, demoLanguage } from '../demoData';
import { Block, BlockHeader } from '../layout';

/** Deadlines from every source in one list: overdue on top, then soonest first. */
export function DeadlinesDemo({ now, timeZone }: { now: Date; timeZone: string }) {
  const { t, i18n } = useTranslation();
  const deadlines = useMemo(
    () => demoDeadlines(now, demoLanguage(i18n.language)),
    [now, i18n.language],
  );

  return (
    <Block>
      <BlockHeader
        title={t('landing.demo.deadlines')}
        aside={<span className="tabular-nums">{deadlines.length}</span>}
      />
      <ul className="divide-y border-t px-4">
        {deadlines.map((deadline) => (
          <li key={deadline.id}>
            <DeadlineRow
              title={deadline.title}
              context={deadline.context}
              source={deadline.source}
              due={deadline.due}
              now={now}
              timeZone={timeZone}
              showSource
            />
          </li>
        ))}
      </ul>
    </Block>
  );
}
