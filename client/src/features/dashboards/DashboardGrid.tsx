import { memo, useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { GripVertical } from 'lucide-react';
import {
  ResponsiveGridLayout,
  useContainerWidth,
  type Layout,
  type LayoutItem as GridLayoutItem,
} from 'react-grid-layout';
import type { Block, LayoutItem, Layouts } from '@api-types/builder';
import type { DashboardView } from '@api-types/dashboards';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { BlockChromeContext, blockTitle, type BlockChrome } from './chrome';
import { sourceState } from './removedSource';
import { BlockMenu, type MenuStep } from './grid/BlockMenu';
import { BlockSlot } from './grid/BlockSlot';
import { useVarOutline } from './varOutlineContext';
import {
  BREAKPOINTS,
  GRID_BREAKPOINT_WIDTHS,
  GRID_COLS,
  GRID_GAP,
  GRID_ROW_HEIGHT,
  rowsToPx,
  type Breakpoint,
} from './grid/constants';
import {
  applyGridStep,
  reduceGridKey,
  type GridKeyOptions,
  type GridKeyResult,
  type GridStep,
} from './grid/keyboard';
import { placeBlocks, plainLayout } from './grid/layouts';
import { mirrorLayout } from './grid/rtl';
import { useGridBreakpoint } from './grid/useGridBreakpoint';
import { blockDefaultSize, blockMinSize } from './registry';
import type { GridSize } from './registry/types';

interface DashboardGridProps {
  dashboard: DashboardView;
  /** Positions per breakpoint, stored left-to-right (pending changes included). */
  layouts: Layouts;
  /** Edit mode: handles, menus, keyboard moves. Never for viewers. */
  editing: boolean;
  /**
   * A drag, resize, key or menu step left this layout (left-to-right). `moved` is the block the
   * user moved or resized; the others in `layout` that changed were pushed by it.
   */
  onCommit: (breakpoint: Breakpoint, layout: LayoutItem[], moved: string | null) => void;
  onRemoveBlock: (blockId: string) => void;
  /** Opens the block editor; until there is one, the menu shows Edit as coming soon. */
  onEditBlock?: ((blockId: string) => void) | undefined;
}

/** The column guides' count, as static classes (index.css draws them in edit mode). */
const GUIDE_COLS: Record<Breakpoint, string> = {
  lg: '[--grid-cols:12]',
  md: '[--grid-cols:8]',
  sm: '[--grid-cols:1]',
};

const DRAG_HANDLE_CLASS = 'block-drag-handle';

function toGridStep(step: MenuStep, dir: 'ltr' | 'rtl'): GridStep {
  const endward = dir === 'rtl' ? -1 : 1;
  switch (step) {
    case 'up':
      return { kind: 'move', dx: 0, dy: -1 };
    case 'down':
      return { kind: 'move', dx: 0, dy: 1 };
    case 'left':
      return { kind: 'move', dx: -endward, dy: 0 };
    case 'right':
      return { kind: 'move', dx: endward, dy: 0 };
    case 'wider':
      return { kind: 'resize', dw: 1, dh: 0 };
    case 'narrower':
      return { kind: 'resize', dw: -1, dh: 0 };
    case 'taller':
      return { kind: 'resize', dw: 0, dh: 1 };
    case 'shorter':
      return { kind: 'resize', dw: 0, dh: -1 };
  }
}

/** The pointer's drag handle at the start of a block's title row (keyboards use the arrows). */
function DragHandle({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      title={label}
      className={cn(
        DRAG_HANDLE_CLASS,
        // 44 × 44px on phones (DESIGN.md touch targets), where the title row is as tall.
        'flex h-9 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-sunken hover:text-foreground active:cursor-grabbing max-md:size-11',
      )}
    >
      <GripVertical className="size-4" />
    </span>
  );
}

interface GridBlockProps {
  dashboard: DashboardView;
  block: Block;
  size: GridSize;
  editing: boolean;
  reorderOnly: boolean;
  menuOpen: boolean;
  onMenuOpenChange: (blockId: string, open: boolean) => void;
  canStep: (blockId: string, step: MenuStep) => boolean;
  onStep: (blockId: string, step: MenuStep) => void;
  onRemove: (block: Block) => void;
  onEdit: ((blockId: string) => void) | undefined;
  onMenuCloseFocus: (blockId: string, event: Event) => void;
}

/** One block with its edit-mode chrome (handle and menu), which BlockFrame places. */
const GridBlock = memo(function GridBlock({
  dashboard,
  block,
  size,
  editing,
  reorderOnly,
  menuOpen,
  onMenuOpenChange,
  canStep,
  onStep,
  onRemove,
  onEdit,
  onMenuCloseFocus,
}: GridBlockProps) {
  const { t } = useTranslation();
  const title = blockTitle(block, t);
  const outlined = useVarOutline().outlined.has(block.id);
  const source = sourceState(block, dashboard.connectors);
  const chrome = useMemo<BlockChrome>(
    () => ({
      editing,
      size,
      outlined,
      source,
      handle: editing ? <DragHandle label={t('dashboard.grid.dragHandle')} /> : null,
      menu: editing ? (
        <BlockMenu
          title={title}
          open={menuOpen}
          onOpenChange={(open) => {
            onMenuOpenChange(block.id, open);
          }}
          canStep={(step) => canStep(block.id, step)}
          onStep={(step) => {
            onStep(block.id, step);
          }}
          reorderOnly={reorderOnly}
          onEdit={
            onEdit === undefined
              ? undefined
              : () => {
                  onEdit(block.id);
                }
          }
          onRemove={() => {
            onRemove(block);
          }}
          onCloseFocus={(event) => {
            onMenuCloseFocus(block.id, event);
          }}
        />
      ) : null,
    }),
    [
      editing,
      size,
      outlined,
      source,
      t,
      title,
      menuOpen,
      onMenuOpenChange,
      block,
      canStep,
      onStep,
      reorderOnly,
      onEdit,
      onRemove,
      onMenuCloseFocus,
    ],
  );
  return (
    <BlockChromeContext.Provider value={chrome}>
      <BlockSlot dashboard={dashboard} block={block} size={size} editing={editing} />
    </BlockChromeContext.Provider>
  );
});

/**
 * The dashboard's grid (FRONTEND.md §5, §11, §12) on react-grid-layout v2: 12 columns from
 * 1200px, 8 from 768px, one column on phones (reorder only), 36px rows and 16px gutters.
 *
 * - Layouts are stored left-to-right; a right-to-left page shows them mirrored and turns drags,
 *   resizes and keys back before they are committed (grid/rtl.ts).
 * - Edit mode (editors and owners only) adds a drag handle and a menu to every block, the
 *   column guides, and keys: arrows move the focused block, Shift and arrows resize it, Enter
 *   opens its menu (grid/keyboard.ts). Moves are announced to screen readers.
 * - Only user actions commit: react-grid-layout's own packing on load is never saved.
 */
export function DashboardGrid({
  dashboard,
  layouts,
  editing,
  onCommit,
  onRemoveBlock,
  onEditBlock,
}: DashboardGridProps) {
  const { t, i18n } = useTranslation();
  const dir = i18n.dir() === 'rtl' ? 'rtl' : 'ltr';
  const breakpoint = useGridBreakpoint();
  const cols = GRID_COLS[breakpoint];
  const reorderOnly = breakpoint === 'sm';
  // One column and not editing: blocks are stacked at their content's height instead of the
  // stored grid height, which would clip a list or table that has more to show (index.css).
  // Editing keeps the grid, whose drag handle needs react-grid-layout's own positions.
  const stacked = reorderOnly && !editing;
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const instructionsId = useId();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Block | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const menuFromKeyboard = useRef(false);
  const { blocks } = dashboard;

  // Every block placed on each breakpoint's grid, left to right.
  const placed = useMemo(
    () => ({
      lg: placeBlocks(layouts.lg, blocks, GRID_COLS.lg, blockDefaultSize),
      md: placeBlocks(layouts.md, blocks, GRID_COLS.md, blockDefaultSize),
      sm: placeBlocks(layouts.sm, blocks, GRID_COLS.sm, blockDefaultSize),
    }),
    [layouts, blocks],
  );
  const typeOf = useMemo(() => new Map(blocks.map((block) => [block.id, block.type])), [blocks]);
  const minFor = useCallback(
    (id: string, gridCols: number): GridSize => {
      const min = blockMinSize(typeOf.get(id) ?? '');
      return { w: Math.min(min.w, gridCols), h: min.h };
    },
    [typeOf],
  );

  // What react-grid-layout shows: mirrored right-to-left, with each block's minimum size.
  const gridLayouts = useMemo(() => {
    const shown: Record<Breakpoint, GridLayoutItem[]> = { lg: [], md: [], sm: [] };
    for (const each of BREAKPOINTS) {
      const gridCols = GRID_COLS[each];
      const items = dir === 'rtl' ? mirrorLayout(placed[each], gridCols) : placed[each];
      shown[each] = items.map((item) => {
        const min = minFor(item.i, gridCols);
        return { ...item, minW: Math.min(min.w, item.w), minH: Math.min(min.h, item.h) };
      });
    }
    return shown;
  }, [placed, dir, minFor]);

  const current = placed[breakpoint];
  const keyOptions = useMemo<GridKeyOptions>(
    () => ({
      cols,
      dir,
      horizontal: !reorderOnly,
      resizable: !reorderOnly,
      minSize: (id) => minFor(id, cols),
    }),
    [cols, dir, reorderOnly, minFor],
  );

  const announce = useCallback(
    (blockId: string, result: Extract<GridKeyResult, { type: 'changed' }>) => {
      const block = blocks.find((entry) => entry.id === blockId);
      if (block === undefined) {
        return;
      }
      const title = blockTitle(block, t);
      const { item } = result;
      if (result.change === 'resize') {
        setAnnouncement(t('dashboard.grid.resized', { title, width: item.w, height: item.h }));
        return;
      }
      const order = [...result.layout].sort((a, b) => a.y - b.y || a.x - b.x);
      setAnnouncement(
        t('dashboard.grid.moved', {
          title,
          column: item.x + 1,
          position: order.findIndex((entry) => entry.i === blockId) + 1,
          count: order.length,
        }),
      );
    },
    [blocks, t],
  );

  const apply = useCallback(
    (blockId: string, result: GridKeyResult) => {
      if (result.type === 'changed') {
        onCommit(breakpoint, result.layout, blockId);
        announce(blockId, result);
      }
    },
    [onCommit, breakpoint, announce],
  );

  const canStep = useCallback(
    (blockId: string, step: MenuStep) =>
      applyGridStep(current, blockId, toGridStep(step, dir), keyOptions).type === 'changed',
    [current, dir, keyOptions],
  );
  const onStep = useCallback(
    (blockId: string, step: MenuStep) => {
      apply(blockId, applyGridStep(current, blockId, toGridStep(step, dir), keyOptions));
    },
    [apply, current, dir, keyOptions],
  );

  const focusBlock = useCallback(
    (blockId: string) => {
      const target = containerRef.current?.querySelector<HTMLElement>(
        `[data-block-id="${CSS.escape(blockId)}"]`,
      );
      target?.focus();
    },
    [containerRef],
  );

  const onMenuOpenChange = useCallback((blockId: string, open: boolean) => {
    if (open) {
      // Radix reports an open it started itself (the button): that one is not the keyboard's.
      menuFromKeyboard.current = false;
    }
    setMenuFor(open ? blockId : null);
  }, []);
  const onMenuCloseFocus = useCallback(
    (blockId: string, event: Event) => {
      // Opened with Enter on the block: back to the block, so the arrows keep working. The flag
      // outlives this call: Radix can report the close more than once (the menu's Escape closes
      // its submenu first), and a second report must not hand focus to the menu button.
      if (menuFromKeyboard.current) {
        event.preventDefault();
        focusBlock(blockId);
      }
    },
    [focusBlock],
  );
  const onRemove = useCallback((block: Block) => {
    menuFromKeyboard.current = false;
    setRemoving(block);
  }, []);

  const onBlockKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, blockId: string) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      const result = reduceGridKey(current, blockId, event, keyOptions);
      if (result.type === 'ignored') {
        return;
      }
      event.preventDefault();
      if (result.type === 'menu') {
        menuFromKeyboard.current = true;
        setMenuFor(blockId);
        return;
      }
      apply(blockId, result);
    },
    [current, keyOptions, apply],
  );

  const commit = useCallback(
    (layout: Layout, _before: GridLayoutItem | null, moved: GridLayoutItem | null) => {
      const items = plainLayout(layout);
      onCommit(breakpoint, dir === 'rtl' ? mirrorLayout(items, cols) : items, moved?.i ?? null);
    },
    [onCommit, breakpoint, dir, cols],
  );

  const sizes = useMemo(
    () => new Map(current.map((item) => [item.i, { w: item.w, h: item.h }])),
    [current],
  );
  const dragConfig = useMemo(
    () => ({ enabled: editing, handle: `.${DRAG_HANDLE_CLASS}` }),
    [editing],
  );
  const resizeConfig = useMemo(
    () => ({
      enabled: editing && !reorderOnly,
      handles: dir === 'rtl' ? (['sw'] as const) : (['se'] as const),
    }),
    [editing, reorderOnly, dir],
  );

  // The stored one-column order: top to bottom (the stack is a flex column, ordered by this).
  const stackOrder = useMemo(
    () =>
      new Map(
        [...current].sort((a, b) => a.y - b.y || a.x - b.x).map((item, index) => [item.i, index]),
      ),
    [current],
  );

  const children = useMemo(
    () =>
      blocks.map((block) => (
        <div
          key={block.id}
          data-block-id={block.id}
          style={stacked ? { order: stackOrder.get(block.id) ?? 0 } : undefined}
          className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          tabIndex={editing ? 0 : undefined}
          role={editing ? 'group' : undefined}
          aria-label={editing ? blockTitle(block, t) : undefined}
          aria-describedby={editing ? instructionsId : undefined}
          onKeyDown={
            editing
              ? (event) => {
                  onBlockKeyDown(event, block.id);
                }
              : undefined
          }
        >
          <GridBlock
            dashboard={dashboard}
            block={block}
            size={sizes.get(block.id) ?? blockDefaultSize(block.type)}
            editing={editing}
            reorderOnly={reorderOnly}
            menuOpen={menuFor === block.id}
            onMenuOpenChange={onMenuOpenChange}
            canStep={canStep}
            onStep={onStep}
            onRemove={onRemove}
            onEdit={onEditBlock}
            onMenuCloseFocus={onMenuCloseFocus}
          />
        </div>
      )),
    [
      blocks,
      editing,
      stacked,
      stackOrder,
      t,
      instructionsId,
      onBlockKeyDown,
      dashboard,
      sizes,
      reorderOnly,
      menuFor,
      onMenuOpenChange,
      canStep,
      onStep,
      onRemove,
      onEditBlock,
      onMenuCloseFocus,
    ],
  );

  // Until the width is measured the grid is not drawn; its height is held so nothing jumps.
  const reservedHeight = rowsToPx(current.reduce((low, item) => Math.max(low, item.y + item.h), 0));
  const removingTitle = removing === null ? '' : blockTitle(removing, t);

  return (
    <>
      <p id={instructionsId} className="sr-only">
        {t(reorderOnly ? 'dashboard.grid.instructionsPhone' : 'dashboard.grid.instructions')}
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div
        ref={containerRef}
        tabIndex={-1}
        className={cn(
          'dashboard-grid relative outline-none',
          GUIDE_COLS[breakpoint],
          editing && 'dashboard-grid--editing',
          stacked && 'dashboard-grid--stacked',
        )}
        style={mounted ? undefined : { minHeight: reservedHeight }}
      >
        {mounted ? (
          <ResponsiveGridLayout
            width={width}
            breakpoint={breakpoint}
            breakpoints={GRID_BREAKPOINT_WIDTHS}
            cols={GRID_COLS}
            layouts={gridLayouts}
            rowHeight={GRID_ROW_HEIGHT}
            margin={[GRID_GAP, GRID_GAP]}
            containerPadding={[0, 0]}
            dragConfig={dragConfig}
            resizeConfig={resizeConfig}
            onDragStop={commit}
            onResizeStop={commit}
          >
            {children}
          </ResponsiveGridLayout>
        ) : null}
      </div>
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
          }
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // The block may be gone: focus the grid, where the next Tab finds the blocks.
            event.preventDefault();
            containerRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('dashboard.grid.removeTitle', { title: removingTitle })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('dashboard.grid.removeBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('dashboard.grid.cancel')}</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing !== null) {
                  onRemoveBlock(removing.id);
                }
                setRemoving(null);
              }}
            >
              {t('dashboard.grid.removeConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
