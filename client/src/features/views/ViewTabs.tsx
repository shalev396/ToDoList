import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Ellipsis, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { DashboardView } from '@api-types/dashboards';
import { canAddView, MAX_VIEWS, SUMMARY_VIEW_ID, viewTabs, type ViewTab } from './viewModel';
import type { ViewActions } from './useViewActions';

interface ViewTabsProps {
  dashboard: DashboardView;
  /** The open view's id (`summary` for the Summary). */
  activeId: string;
  onSelect: (viewId: string) => void;
  /** An editor or owner on the draft: "+ Add view" is offered. */
  canEdit: boolean;
  /** Edit mode: each tab gets its menu (rename, move, remove). */
  editing: boolean;
  actions: ViewActions;
  onAdd: () => void;
}

function tabLabel(tab: ViewTab, t: (key: string) => string): string {
  return tab.title ?? t('views.summary');
}

function RenameDialog({
  open,
  title,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  onSave: (title: string) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(title);
  const trimmed = value.trim();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogContent closeLabel={t('views.close')} data-view-rename>
        <DialogHeader>
          <DialogTitle>{t('views.rename.title')}</DialogTitle>
          <DialogDescription>{t('views.rename.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed !== '') {
              onSave(trimmed);
            }
          }}
        >
          <Input
            value={value}
            maxLength={80}
            aria-label={t('views.rename.label')}
            data-view-name-input
            onChange={(event) => {
              setValue(event.target.value);
            }}
            dir="auto"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('views.cancel')}
            </Button>
            <Button type="submit" disabled={trimmed === ''}>
              {t('views.rename.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The menu of the open tab in edit mode. The Summary's is fixed: it says so and offers nothing. */
function TabMenu({
  tab,
  index,
  count,
  actions,
}: {
  tab: ViewTab;
  index: number;
  count: number;
  actions: ViewActions;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const label = tabLabel(tab, t);
  const position = index - 1;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground max-md:size-11"
            aria-label={t('views.menu.label', { title: label })}
            data-view-menu={tab.id}
          >
            {tab.fixed ? <Lock aria-hidden="true" /> : <Ellipsis aria-hidden="true" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          {tab.fixed ? (
            <DropdownMenuLabel className="max-w-64 whitespace-normal font-normal text-muted-foreground">
              {t('views.menu.summaryFixed')}
            </DropdownMenuLabel>
          ) : null}
          <DropdownMenuItem
            disabled={tab.fixed}
            onSelect={() => {
              setRenaming(true);
            }}
          >
            <Pencil aria-hidden="true" />
            {t('views.menu.rename')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={tab.fixed || position <= 0}
            onSelect={() => {
              void actions.moveView(tab.id, position - 1);
            }}
          >
            <ArrowLeft aria-hidden="true" className="rtl:-scale-x-100" />
            {t('views.menu.moveEarlier')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={tab.fixed || position >= count - 1}
            onSelect={() => {
              void actions.moveView(tab.id, position + 1);
            }}
          >
            <ArrowRight aria-hidden="true" className="rtl:-scale-x-100" />
            {t('views.menu.moveLater')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={tab.fixed}
            data-view-remove
            onSelect={() => {
              setRemoving(true);
            }}
          >
            <Trash2 aria-hidden="true" />
            {t('views.menu.remove')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {renaming ? (
        <RenameDialog
          open
          title={tab.title ?? ''}
          onClose={() => {
            setRenaming(false);
          }}
          onSave={(title) => {
            setRenaming(false);
            void actions.renameView(tab.id, title);
          }}
        />
      ) : null}
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('views.remove.title', { title: label })}</AlertDialogTitle>
            <AlertDialogDescription>{t('views.remove.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('views.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-view-remove-confirm
              onClick={() => {
                void actions.removeView(tab.id);
              }}
            >
              {t('views.remove.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * The page's view tabs (H3): the Summary first and fixed, then the views in order, then "+ Add
 * view" for editors. A tablist that scrolls sideways on a phone; arrows move between tabs.
 */
export function ViewTabs({
  dashboard,
  activeId,
  onSelect,
  canEdit,
  editing,
  actions,
  onAdd,
}: ViewTabsProps) {
  const { t } = useTranslation();
  const tabs = viewTabs(dashboard);
  // A page with only the Summary and no editor has nothing to switch to.
  if (tabs.length === 1 && !canEdit) {
    return null;
  }
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeId),
  );
  const activeTab = tabs[activeIndex];
  const move = (to: number) => {
    const next = tabs[(to + tabs.length) % tabs.length];
    if (next !== undefined) {
      onSelect(next.id);
    }
  };
  return (
    <div className="mb-4 flex items-center gap-2" data-view-tabs>
      <div
        role="tablist"
        aria-label={t('views.tabs')}
        className="flex min-w-0 flex-1 gap-1 overflow-x-auto border-b"
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            const rtl = document.dir === 'rtl';
            const forward = (event.key === 'ArrowRight') !== rtl;
            move(activeIndex + (forward ? 1 : -1));
            event.preventDefault();
          }
        }}
      >
        {tabs.map((tab, index) => {
          const selected = index === activeIndex;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`view-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls="view-panel"
              tabIndex={selected ? 0 : -1}
              data-view-tab={tab.id}
              onClick={() => {
                onSelect(tab.id);
              }}
              className={cn(
                'inline-flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm whitespace-nowrap focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-fine:min-h-10',
                selected
                  ? 'border-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
              dir="auto"
            >
              {tabLabel(tab, t)}
            </button>
          );
        })}
      </div>
      {editing && activeTab !== undefined ? (
        <TabMenu tab={activeTab} index={activeIndex} count={tabs.length} actions={actions} />
      ) : null}
      {canEdit ? (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 max-md:h-11"
          data-add-view
          disabled={!canAddView(dashboard) || actions.pending}
          title={canAddView(dashboard) ? undefined : t('views.add.limit', { count: MAX_VIEWS })}
          onClick={onAdd}
        >
          <Plus aria-hidden="true" />
          {t('views.addView')}
        </Button>
      ) : null}
    </div>
  );
}

export { SUMMARY_VIEW_ID };
