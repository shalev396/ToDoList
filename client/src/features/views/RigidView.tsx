import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BlockChromeContext, blockTitle, type BlockChrome } from '@/features/dashboards/chrome';
import { BlockSlot } from '@/features/dashboards/grid/BlockSlot';
import { sourceState } from '@/features/dashboards/removedSource';
import type { Block } from '@api-types/builder';
import type { DashboardView } from '@api-types/dashboards';

/** A full-page block is this many grid rows tall, for its skeleton (the page scrolls inside it). */
const FULL_PAGE_ROWS = 22;

interface RigidViewProps {
  dashboard: DashboardView;
  block: Block;
  /** Edit mode: the block's Edit view button (sources, filter, sort, group, visible fields). */
  editing: boolean;
  onEdit: (blockId: string) => void;
}

/**
 * A rigid view (H3): one full-page block of its type, with no grid to edit. What is editable is
 * the block's own settings, through the same editor as any block (sources with the share
 * confirmation, the sentence filter, sort, group-by, visible fields): "Edit view".
 */
export function RigidView({ dashboard, block, editing, onEdit }: RigidViewProps) {
  const { t } = useTranslation();
  const title = blockTitle(block, t);
  const source = sourceState(block, dashboard.connectors);
  const chrome = useMemo<BlockChrome>(
    () => ({
      editing,
      handle: null,
      size: { w: 12, h: FULL_PAGE_ROWS },
      outlined: false,
      source,
      menu: editing ? (
        <Button
          variant="outline"
          size="sm"
          className="max-md:h-11"
          data-edit-view
          aria-label={t('views.rigid.editLabel', { title })}
          onClick={() => {
            onEdit(block.id);
          }}
        >
          <Pencil aria-hidden="true" />
          {t('views.rigid.edit')}
        </Button>
      ) : null,
    }),
    [editing, source, t, title, onEdit, block.id],
  );
  return (
    <div className="h-[calc(100dvh-17rem)] min-h-96" data-rigid-view={block.type}>
      <BlockChromeContext.Provider value={chrome}>
        <BlockSlot
          dashboard={dashboard}
          block={block}
          size={chrome.size ?? { w: 12, h: FULL_PAGE_ROWS }}
          editing={editing}
        />
      </BlockChromeContext.Provider>
    </div>
  );
}
