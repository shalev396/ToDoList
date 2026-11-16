import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { BlockType } from '@api-types/builder';
import type { DashboardView } from '@api-types/dashboards';
import { usePageVars } from './pageVars';
import { buildPageVarEntries, varValueText, type PageVarEntry } from './pageVarsModel';
import { useUrlVars } from './useUrlVars';

function useBlockName(): (title: string, type: BlockType) => string {
  const { t } = useTranslation();
  return (title, type) => (title === '' ? t(`blocks.types.${type}`) : title);
}

function VarRow({ entry, onClear }: { entry: PageVarEntry; onClear: () => void }) {
  const { t } = useTranslation();
  const name = useBlockName();
  const value = varValueText(entry.value);
  return (
    <li
      data-page-var={entry.name}
      className="flex flex-col gap-1.5 border-b py-3 text-[13px] last:border-b-0"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <code className="font-mono text-[13px] font-semibold break-all" dir="ltr">
            {`$page.${entry.name}`}
          </code>
          <span
            data-page-var-value
            className={cn('break-words', value === '' && 'text-muted-foreground')}
            dir="auto"
          >
            {value === '' ? t('pageVars.notSet') : value}
          </span>
        </div>
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 max-md:h-11"
          disabled={!entry.clearable}
          aria-label={t('pageVars.clearLabel', { name: entry.name })}
          data-page-var-clear
          onClick={onClear}
        >
          <X aria-hidden="true" />
          {t('pageVars.clear')}
        </Button>
      </div>
      {entry.origin === 'unset' ? null : (
        <p className="text-muted-foreground" data-page-var-origin={entry.origin}>
          {t(`pageVars.origin.${entry.origin}`)}
        </p>
      )}
      {entry.setters.length === 0 ? null : (
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">{t('pageVars.setBy')} </span>
          {entry.setters
            .map(
              (setter) =>
                `${t(`pageVars.kind.${setter.kind}`)} “${name(setter.title, setter.type)}”`,
            )
            .join(', ')}
        </p>
      )}
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">{t('pageVars.usedBy')} </span>
        {entry.listeners.length === 0
          ? t('pageVars.nobody')
          : entry.listeners
              .map(
                (listener) =>
                  `“${name(listener.title, listener.type)}” (${listener.viewTitle ?? t('views.summary')})`,
              )
              .join(', ')}
      </p>
    </li>
  );
}

interface PageVarsPanelProps {
  dashboard: Pick<DashboardView, 'vars' | 'blocks' | 'views'>;
}

/**
 * The page-variables panel (D4): in edit mode, every `$page.*` variable of the page with its
 * value, where it is set (the URL, a filter block, a chart click, the route, the page default),
 * which blocks and views listen to it, and a Clear. It covers the Summary and every view. On a
 * phone it collapses; on a wide screen it sits beside the page.
 */
export function PageVarsPanel({ dashboard }: PageVarsPanelProps) {
  const { t } = useTranslation();
  const { vars, setVar, bound } = usePageVars();
  const { urlVars } = useUrlVars();
  const [open, setOpen] = useState(() => !window.matchMedia('(max-width: 1023px)').matches);
  const entries = useMemo(
    () => buildPageVarEntries({ dashboard, vars, urlVars, bound }),
    [dashboard, vars, urlVars, bound],
  );
  return (
    <aside
      data-page-vars-panel
      aria-label={t('pageVars.title')}
      className="rounded-lg border bg-card lg:sticky lg:top-4 lg:self-start"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls="page-vars-body"
        data-page-vars-toggle
        onClick={() => {
          setOpen((current) => !current);
        }}
        className="flex min-h-11 w-full items-center justify-between gap-2 px-4 text-start text-sm font-semibold focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span>
          {t('pageVars.title')}
          <span className="ms-1.5 font-normal text-muted-foreground">{entries.length}</span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>
      <div id="page-vars-body" hidden={!open} className="border-t px-4">
        {entries.length === 0 ? (
          <p className="py-3 text-[13px] text-muted-foreground" data-page-vars-empty>
            {t('pageVars.empty')}
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {entries.map((entry) => (
              <VarRow
                key={entry.name}
                entry={entry}
                onClear={() => {
                  setVar(entry.name, null);
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
