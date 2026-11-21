import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CalendarCheck,
  CalendarDays,
  CalendarRange,
  GanttChart,
  Gauge,
  LayoutGrid,
  List,
  SquareKanban,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import { useViewTemplates } from '@/api/queries/builder';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useTemplateShareConfirm } from '@/features/templates/useTemplateShareConfirm';
import { cn } from '@/lib/utils';
import type { PageView, ViewType } from '@api-types/builder';
import type { ViewTemplateSummary } from '@api-types/dashboards';
import { CUSTOM_VIEW_TYPES } from './viewModel';
import type { ViewActions } from './useViewActions';

const TYPE_ICONS: Readonly<Record<ViewType, LucideIcon>> = {
  list: List,
  board: SquareKanban,
  timeline: GanttChart,
  calendar: CalendarDays,
  table: Table2,
  agenda: CalendarCheck,
  workload: Gauge,
  timesheet: CalendarRange,
  dashboard: LayoutGrid,
};

type Mode = 'custom' | 'template';

interface AddViewDialogProps {
  workspaceId: string;
  language: 'en' | 'he';
  actions: ViewActions;
  onClose: () => void;
  /** The view was added: open it. */
  onAdded: (view: PageView) => void;
}

function ModeButton({
  mode,
  current,
  onPick,
  children,
}: {
  mode: Mode;
  current: Mode;
  onPick: (mode: Mode) => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={mode === current}
      data-add-view-mode={mode}
      onClick={() => {
        onPick(mode);
      }}
      className={cn(
        'inline-flex min-h-11 items-center border-b-2 px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-fine:min-h-10',
        mode === current
          ? 'border-foreground font-medium'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/**
 * "+ Add view" (H3): a custom view (pick a type) or one from a template. A template's data blocks
 * bind to the member's own matching connections; when that would share one that no block holds
 * yet, the shared "Share and create" confirmation asks first (never silently).
 */
export function AddViewDialog({
  workspaceId,
  language,
  actions,
  onClose,
  onAdded,
}: AddViewDialogProps) {
  const { t } = useTranslation();
  const templates = useViewTemplates(workspaceId);
  const shareConfirm = useTemplateShareConfirm(workspaceId);
  const [mode, setMode] = useState<Mode>('custom');
  const [type, setType] = useState<ViewType>('list');
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const title = name.trim() === '' ? undefined : name.trim();

  const submit = async () => {
    setBusy(true);
    try {
      let added: PageView | null;
      if (mode === 'custom') {
        // A custom view is named in the member's language unless they type a name.
        added = await actions.addView({
          kind: 'custom',
          type,
          title: title ?? t(`views.types.${type}`),
        });
      } else {
        if (templateKey === null) {
          return;
        }
        // Templates never share silently: ask first when they would attach unshared connections.
        const choice = await shareConfirm.ask([templateKey]);
        if (choice === null) {
          return;
        }
        added = await actions.addView(
          { kind: 'template', templateKey, title },
          choice.shareIntegrations,
        );
      }
      if (added !== null) {
        onAdded(added);
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !busy && (mode === 'custom' || templateKey !== null);
  const list: ViewTemplateSummary[] = templates.data ?? [];

  return (
    <>
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
      >
        <DialogContent closeLabel={t('views.close')} className="max-w-xl" data-add-view-dialog>
          <DialogHeader>
            <DialogTitle>{t('views.add.title')}</DialogTitle>
            <DialogDescription>{t('views.add.description')}</DialogDescription>
          </DialogHeader>
          <div role="tablist" aria-label={t('views.add.title')} className="flex gap-1 border-b">
            <ModeButton mode="custom" current={mode} onPick={setMode}>
              {t('views.add.custom')}
            </ModeButton>
            <ModeButton mode="template" current={mode} onPick={setMode}>
              {t('views.add.fromTemplate')}
            </ModeButton>
          </div>

          {mode === 'custom' ? (
            <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3">
              {CUSTOM_VIEW_TYPES.map((each) => {
                const Icon = TYPE_ICONS[each];
                return (
                  <li key={each}>
                    <button
                      type="button"
                      data-view-type={each}
                      aria-pressed={each === type}
                      onClick={() => {
                        setType(each);
                      }}
                      className={cn(
                        'flex min-h-11 w-full flex-col items-start gap-1 rounded-md border bg-card px-3 py-2.5 text-start text-sm transition-colors hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                        each === type && 'border-foreground bg-sunken',
                      )}
                    >
                      <span className="inline-flex items-center gap-2 font-medium">
                        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
                        {t(`views.types.${each}`)}
                      </span>
                      <span className="text-[13px] text-muted-foreground">
                        {t(`views.typeHints.${each}`)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : templates.data === undefined ? (
            templates.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {t('views.add.templatesError')}
              </p>
            ) : (
              <div className="grid gap-2" aria-busy="true">
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
              </div>
            )
          ) : (
            <ul className="m-0 grid max-h-72 list-none gap-2 overflow-y-auto p-0">
              {list.map((template) => {
                const Icon = TYPE_ICONS[template.type];
                return (
                  <li key={template.key}>
                    <button
                      type="button"
                      data-view-template={template.key}
                      aria-pressed={template.key === templateKey}
                      onClick={() => {
                        setTemplateKey(template.key);
                      }}
                      className={cn(
                        'flex min-h-11 w-full items-center gap-3 rounded-md border bg-card px-3 py-2.5 text-start text-sm transition-colors hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                        template.key === templateKey && 'border-foreground bg-sunken',
                      )}
                    >
                      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium" dir="auto">
                          {template.titles[language]}
                        </span>
                        <span className="text-[13px] text-muted-foreground">
                          {t(`views.types.${template.type}`)}
                          {template.blockTypes.length > 1
                            ? ` · ${t('templates.blockCount', { count: template.blockTypes.length })}`
                            : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <label className="grid gap-1.5 text-[13px] font-medium">
            {t('views.add.name')}
            <Input
              value={name}
              maxLength={80}
              placeholder={t('views.add.namePlaceholder')}
              data-view-name-input
              onChange={(event) => {
                setName(event.target.value);
              }}
              dir="auto"
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('views.cancel')}
            </Button>
            <Button
              type="button"
              data-add-view-submit
              disabled={!canSubmit || shareConfirm.checking}
              onClick={() => {
                void submit();
              }}
            >
              {t(busy ? 'views.add.adding' : 'views.add.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {shareConfirm.dialog}
    </>
  );
}
