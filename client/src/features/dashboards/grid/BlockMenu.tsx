import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Ellipsis,
  Move,
  Pencil,
  Scaling,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** A step of the menu's Move and Resize items. Left and right are on screen. */
export type MenuStep =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'wider'
  | 'narrower'
  | 'taller'
  | 'shorter';

interface StepItem {
  step: MenuStep;
  icon: LucideIcon;
  /** Points along the row toward its end: flipped right-to-left. */
  endward?: boolean;
}

const MOVES: readonly StepItem[] = [
  { step: 'up', icon: ArrowUp },
  { step: 'down', icon: ArrowDown },
  { step: 'left', icon: ArrowLeft },
  { step: 'right', icon: ArrowRight },
];
const SIZES: readonly StepItem[] = [
  { step: 'wider', icon: ArrowRight, endward: true },
  { step: 'narrower', icon: ArrowLeft, endward: true },
  { step: 'taller', icon: ArrowDown },
  { step: 'shorter', icon: ArrowUp },
];

interface BlockMenuProps {
  /** The block's title, for the button's name. */
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether a step changes the layout now (false at an edge or a minimum). */
  canStep: (step: MenuStep) => boolean;
  onStep: (step: MenuStep) => void;
  /** Phones: reorder only, so no sideways moves and no resizing. */
  reorderOnly: boolean;
  /** Opens the block editor; the item is shown as coming soon without it. */
  onEdit?: (() => void) | undefined;
  onRemove: () => void;
  /** Where focus goes when the menu closes (the block, when Enter opened it). */
  onCloseFocus?: ((event: Event) => void) | undefined;
}

/**
 * A block's edit-mode menu (FRONTEND.md §11): Move and Resize as a non-drag fallback, Edit, and
 * Remove. Move and Resize steps keep the menu open, so a block can be walked across the grid.
 */
export function BlockMenu({
  title,
  open,
  onOpenChange,
  canStep,
  onStep,
  reorderOnly,
  onEdit,
  onRemove,
  onCloseFocus,
}: BlockMenuProps) {
  const { t } = useTranslation();

  const stepItem = ({ step, icon: Icon, endward = false }: StepItem) => (
    <DropdownMenuItem
      key={step}
      disabled={!canStep(step)}
      onSelect={(event) => {
        event.preventDefault();
        onStep(step);
      }}
    >
      <Icon aria-hidden="true" className={endward ? 'rtl:-scale-x-100' : undefined} />
      {t(`dashboard.grid.steps.${step}`)}
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground max-md:size-11"
          aria-label={t('dashboard.grid.menu', { title })}
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44" onCloseAutoFocus={onCloseFocus}>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Move aria-hidden="true" />
            {t('dashboard.grid.move')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {MOVES.filter(({ step }) => !reorderOnly || step === 'up' || step === 'down').map(
              stepItem,
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {reorderOnly ? null : (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Scaling aria-hidden="true" />
              {t('dashboard.grid.resize')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>{SIZES.map(stepItem)}</DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuItem
          disabled={onEdit === undefined}
          onSelect={() => {
            onEdit?.();
          }}
        >
          <Pencil aria-hidden="true" />
          {t('dashboard.grid.edit')}
          {onEdit === undefined ? (
            <span className="ms-auto text-xs text-muted-foreground">
              {t('dashboard.grid.editSoon')}
            </span>
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onRemove}>
          <Trash2 aria-hidden="true" />
          {t('dashboard.grid.remove')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
