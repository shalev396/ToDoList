import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useBuilderCatalog } from '@/api/queries/builder';
import { useFacets } from '@/api/queries/items';
import { listeningSources } from './filter/listeningSources';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SelectField } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { BlockFrame, type BlockStatus } from '../BlockFrame';
import { blockTitle } from '../chrome';
import type { BlockComponentProps } from '../registry/types';
import { varNameOf } from '../variables/names';
import { usePageVars } from '../variables/pageVars';
import { useVarOutline } from '../varOutlineContext';
import {
  facetOptions,
  nextSelection,
  selectedValues,
  type FacetOption,
} from './filter/facetOptions';

const MAX_INLINE = 4;

/**
 * The filter block: chips, a select or date presets that set one page variable (`block.sets`).
 * Options come only from `GET …/facets` (and the catalog's date presets), never from a hard-coded
 * list. While the block is focused or hovered it outlines the blocks that listen to its variable.
 */
export default function FilterBlock({ block, dashboard }: BlockComponentProps) {
  const { t } = useTranslation();
  const { workspace, topics } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? null;
  const { vars, setVar, clearVar, bound } = usePageVars();
  const { highlight } = useVarOutline();
  // Only values present in what the listening blocks read (PERMISSIONS-V2 ruling 13).
  const facets = useFacets(workspaceId, listeningSources(block, dashboard.blocks));
  const catalog = useBuilderCatalog(workspaceId ?? '');

  const viz = block.viz as { kind?: string; field?: string; multi?: boolean };
  const name = block.sets === undefined ? null : varNameOf(block.sets);
  const current = name === null ? undefined : vars[name];
  const fixed = name !== null && bound.has(name);
  const held = selectedValues(current);
  const isPresets = viz.kind === 'datePresets';

  let options: FacetOption[];
  let loading: boolean;
  let failed: boolean;
  if (isPresets) {
    options = (catalog.data?.datePresets ?? []).map((preset) => ({
      value: preset,
      labelKey: `blocks.filter.presets.${preset}`,
    }));
    loading = catalog.isLoading && workspaceId !== null;
    failed = catalog.isError;
  } else {
    options = facets.data === undefined ? [] : facetOptions(viz.field, facets.data, topics);
    loading = facets.isLoading;
    failed = facets.isError;
  }

  const status: BlockStatus = loading
    ? 'loading'
    : failed
      ? 'error'
      : options.length === 0
        ? 'empty'
        : 'ready';
  const labelOf = (option: FacetOption): string =>
    option.labelKey === undefined ? option.label : t(option.labelKey);
  const choose = (value: string) => {
    if (name === null || fixed) {
      return;
    }
    const next = nextSelection(current, value, viz.multi === true && !isPresets);
    if (next === null) {
      clearVar(name);
    } else {
      setVar(name, next);
    }
  };
  const title = blockTitle(block, t);
  const listened = block.sets;
  // One row: the first few options inline (any chosen one stays visible), the rest in a popover.
  const hidden = options.slice(MAX_INLINE).filter((option) => !held.includes(option.value));
  const inline = options.filter((option) => !hidden.includes(option));
  const rest = hidden;
  const renderChip = (option: FacetOption) => {
    const pressed = held.includes(option.value);
    return (
      <button
        key={option.value}
        type="button"
        aria-pressed={pressed}
        disabled={fixed}
        title={fixed ? t('blocks.filter.bound') : labelOf(option)}
        onClick={() => {
          choose(option.value);
        }}
        className={cn(
          'inline-flex h-7 pointer-coarse:h-11 max-w-48 shrink-0 items-center rounded-full border px-3 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
          pressed
            ? 'border-foreground bg-foreground text-background'
            : 'bg-card text-foreground hover:bg-sunken',
        )}
      >
        <span className="truncate" dir="auto">
          {labelOf(option)}
        </span>
      </button>
    );
  };

  return (
    <BlockFrame
      title={title}
      status={status}
      emptyMessage={t('blocks.filter.noOptions')}
      onRetry={() => {
        void facets.refetch();
        void catalog.refetch();
      }}
      actions={
        held.length > 0 && !fixed && name !== null ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="pointer-coarse:size-11"
            aria-label={t('blocks.filter.clear')}
            title={t('blocks.filter.clear')}
            onClick={() => {
              clearVar(name);
            }}
          >
            <X aria-hidden="true" />
          </Button>
        ) : undefined
      }
    >
      <div
        data-filter={name ?? ''}
        className="flex min-w-0 items-center"
        onMouseEnter={() => {
          highlight(listened);
        }}
        onMouseLeave={() => {
          highlight(undefined);
        }}
        onFocus={() => {
          highlight(listened);
        }}
        onBlur={() => {
          highlight(undefined);
        }}
      >
        {viz.kind === 'select' ? (
          <SelectField
            aria-label={t('blocks.filter.label', { title })}
            value={held[0] ?? ''}
            disabled={fixed}
            onValueChange={(next) => {
              if (name === null) {
                return;
              }
              if (next === '') {
                clearVar(name);
              } else {
                setVar(name, next);
              }
            }}
            className="w-full max-w-xs"
            triggerClassName="h-7 min-h-7 pointer-coarse:h-11 pointer-coarse:min-h-11"
            options={[
              { value: '', label: t('blocks.filter.all') },
              ...options.map((option) => ({ value: option.value, label: labelOf(option) })),
            ]}
          />
        ) : (
          <div
            role="group"
            aria-label={t('blocks.filter.label', { title })}
            className="flex min-w-0 flex-wrap gap-1.5"
          >
            {inline.map(renderChip)}
            {rest.length > 0 ? (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-filter-more
                    className="inline-flex h-7 pointer-coarse:h-11 shrink-0 items-center rounded-full border border-dashed bg-card px-3 text-[13px] text-muted-foreground transition-colors outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t('blocks.filter.more', { count: rest.length })}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="flex w-auto max-w-80 flex-wrap gap-1.5 p-3"
                >
                  {rest.map(renderChip)}
                </PopoverContent>
              </Popover>
            ) : null}
          </div>
        )}
      </div>
    </BlockFrame>
  );
}
