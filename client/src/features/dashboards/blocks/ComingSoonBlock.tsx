import { useTranslation } from 'react-i18next';
import { LayoutGrid } from 'lucide-react';
import { useBlockData } from '@/api/queries/blocks';
import { BlockFrame, type BlockStatus } from '../BlockFrame';
import { blockTitle } from '../chrome';
import { useBlockEntry } from '../registry/blockEntryContext';
import type { BlockComponentProps } from '../registry/types';
import { usePageVars } from '../variables/pageVars';

/**
 * Every block type's placeholder until its real component lands in the registry: the frame with
 * the type's icon and "This block is coming soon". A data block already fetches its result, so
 * the page makes one request per block and the frame's loading and error states are live.
 */
export default function ComingSoonBlock({ dashboard, block }: BlockComponentProps) {
  const { t } = useTranslation();
  const { vars } = usePageVars();
  const data = useBlockData(dashboard, block, vars);
  const Icon = useBlockEntry()?.icon ?? LayoutGrid;
  const status: BlockStatus = data.isLoading ? 'loading' : data.isError ? 'error' : 'empty';

  return (
    <BlockFrame
      title={blockTitle(block, t)}
      status={status}
      onRetry={() => {
        void data.refetch();
      }}
      emptyIcon={<Icon />}
      emptyMessage={t('blocks.comingSoon')}
    />
  );
}
