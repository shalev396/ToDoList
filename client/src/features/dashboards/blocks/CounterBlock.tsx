import { useTranslation } from 'react-i18next';
import { Hash } from 'lucide-react';
import { dateLocale } from '@/components/items/format';
import { BlockFrame } from '../BlockFrame';
import { blockTitle } from '../chrome';
import type { BlockComponentProps } from '../registry/types';
import { counterValue } from './data/rows';
import { useDataBlock } from './data/useDataBlock';

/**
 * Counter (FRONTEND.md §5): one hero number and a computed label ("items"). A delta (`showDelta`)
 * is drawn only when the query returns one; the catalog's queries do not, so none is shown.
 */
export default function CounterBlock({ dashboard, block }: BlockComponentProps) {
  const { t, i18n } = useTranslation();
  const { query, loadState } = useDataBlock(dashboard, block);
  const value = counterValue(query.data);
  const status = loadState !== 'ready' ? loadState : value === undefined ? 'empty' : 'ready';
  const formatted =
    value === undefined ? '' : new Intl.NumberFormat(dateLocale(i18n.language)).format(value);

  return (
    <BlockFrame
      title={blockTitle(block, t)}
      status={status}
      onRetry={() => {
        void query.refetch();
      }}
      emptyIcon={<Hash />}
      emptyMessage={t('dataBlocks.counter.empty')}
    >
      <p className="flex h-full min-h-0 flex-col justify-center">
        <span className="text-4xl leading-none font-semibold tracking-tight text-foreground tabular-nums">
          {formatted}
        </span>
        <span className="mt-1.5 truncate text-[13px] text-muted-foreground">
          {t('dataBlocks.counter.items', { count: value ?? 0 })}
        </span>
      </p>
    </BlockFrame>
  );
}
