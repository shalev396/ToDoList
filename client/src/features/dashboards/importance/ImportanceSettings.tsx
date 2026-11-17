/**
 * Per-page importance settings (H4): pick how this page scores `importance` (0 to 100) and, for
 * Weighted, how much each factor weighs. Every method and every factor is explained in plain
 * words with an example, and a live "top 5" shows what the choice does to this page's items. The
 * choice is stored on the page (one `set_importance` op); viewers can read it, editors change it.
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { apiConflictVersion, errorMessage } from '@/api/errors';
import { useAttributes } from '@/api/queries/attributes';
import { useApplyDashboardOps } from '@/api/queries/dashboards';
import { queryKeys } from '@/api/queries/keys';
import { QUERY_STALE_TIME_PRIVATE_MS } from '@/api/queries/queryOptions';
import { runQuery } from '@/api/services/queryService';
import { useDebounced } from '@/features/editor/useDebounced';
import type { DashboardView } from '@api-types/dashboards';
import { IMPORTANCE_PRESETS, MAX_WEIGHT, type ImportanceConfig } from '@api-types/importance';
import type { ItemQueryRow } from '@api-types/builder';
import { configOf, configToStore, weightsShown, withPreset, withWeight } from './importanceModel';

const PREVIEW_DEBOUNCE_MS = 300;
const TOP = 5;

/** The live "top 5": this page's items ranked by the config being edited. */
function TopFive({
  workspaceId,
  config,
  scope,
}: {
  workspaceId: string;
  config: ImportanceConfig;
  scope: DashboardView['scope'];
}) {
  const { t } = useTranslation();
  const key = useDebounced(JSON.stringify(config), PREVIEW_DEBOUNCE_MS);
  // This page's items: its topic, and its container on a group page (the main page has neither).
  const scopeRules = [
    ...(scope.topicId === null
      ? []
      : [{ field: 'topic', operator: '=' as const, value: scope.topicId }]),
    ...(scope.containerId === null
      ? []
      : [{ field: 'containerId', operator: '=' as const, value: scope.containerId }]),
  ];
  const scopeKey = JSON.stringify(scopeRules);
  const preview = useQuery({
    queryKey: [...queryKeys.dashboards(workspaceId), 'importance-preview', key, scopeKey],
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await runQuery(
        workspaceId,
        {
          draft: {
            source: 'items',
            where: {
              combinator: 'and',
              rules: [
                { field: 'status', operator: 'in', value: ['open', 'in_progress'] },
                ...scopeRules,
              ],
            },
            sort: [{ field: 'importance', dir: 'desc' }],
            limit: TOP,
          },
          importance: JSON.parse(key) as ImportanceConfig,
          preview: true,
        },
        { signal, suppressErrorToast: true },
      );
      return (response.data.rows ?? []) as ItemQueryRow[];
    },
  });
  return (
    <section
      aria-labelledby="importance-top"
      className="flex flex-col gap-2"
      data-importance-preview
    >
      <h3 id="importance-top" className="text-sm font-semibold">
        {t('logic.importance.previewTitle')}
      </h3>
      {preview.isError ? (
        <p role="alert" className="text-[13px] text-destructive">
          {t('logic.importance.previewError')}
        </p>
      ) : preview.data === undefined ? (
        <p role="status" className="text-[13px] text-muted-foreground">
          {t('logic.importance.previewLoading')}
        </p>
      ) : preview.data.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('logic.importance.previewEmpty')}</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {preview.data.map((row) => (
            <li
              key={row.id}
              className="flex items-baseline justify-between gap-3 rounded-sm border bg-card px-3 py-1.5 text-sm"
            >
              <span className="truncate" dir="auto">
                {row.title}
              </span>
              <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums">
                {t('logic.importance.score', { score: row.importance ?? 0 })}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function ImportanceSettings({
  workspaceId,
  dashboard,
  language,
  onClose,
}: {
  workspaceId: string;
  dashboard: DashboardView;
  language: 'en' | 'he';
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const attributesQuery = useAttributes(workspaceId);
  const attributes = useMemo(() => attributesQuery.data ?? [], [attributesQuery.data]);
  const applyOps = useApplyDashboardOps(workspaceId, dashboard.id);
  const stored = configOf(dashboard.importance);
  const [config, setConfig] = useState<ImportanceConfig>(stored);
  const [keptWeights, setKeptWeights] = useState<Record<string, number> | undefined>(
    stored.preset === 'weighted' ? stored.params.weights : undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const shown = useMemo(() => weightsShown(config, attributes), [config, attributes]);

  const save = async (next: ImportanceConfig | null): Promise<void> => {
    setError(null);
    const draftKey = queryKeys.dashboard(workspaceId, dashboard.id, 'draft');
    const expectedVersion =
      queryClient.getQueryData<DashboardView>(draftKey)?.version ?? dashboard.version;
    try {
      await applyOps.mutateAsync({
        expectedVersion,
        ops: [{ op: 'set_importance', importance: next }],
        language,
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.dashboardCopies(workspaceId, dashboard.id),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.dashboardBlocks(workspaceId, dashboard.id),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.dashboardVersions(workspaceId, dashboard.id),
        }),
      ]);
      toast.success(t('logic.importance.saved'));
      onClose();
    } catch (failure) {
      setError(
        apiConflictVersion(failure) !== null
          ? t('logic.importance.conflict')
          : errorMessage(t, failure, 'logic.importance.saveError'),
      );
    }
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent
        closeLabel={t('editor.close')}
        className="flex w-full flex-col gap-5 overflow-y-auto sm:max-w-lg"
        data-importance-settings
      >
        <SheetHeader>
          <SheetTitle>{t('logic.importance.title')}</SheetTitle>
          <p className="text-sm text-muted-foreground">{t('logic.importance.description')}</p>
        </SheetHeader>
        <div className="flex flex-col gap-5 px-4 pb-6">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t('logic.importance.preset')}</legend>
            <RadioGroup
              value={config.preset}
              aria-label={t('logic.importance.preset')}
              onValueChange={(value) => {
                const preset = IMPORTANCE_PRESETS.find((entry) => entry === value);
                if (preset === undefined) {
                  return;
                }
                if (config.preset === 'weighted') {
                  setKeptWeights(config.params.weights ?? keptWeights);
                }
                setConfig(withPreset(preset, keptWeights));
              }}
            >
              {IMPORTANCE_PRESETS.map((preset) => (
                <label
                  key={preset}
                  className="flex min-h-6 items-center gap-2 text-sm max-md:min-h-11"
                >
                  <RadioGroupItem value={preset} data-importance-preset={preset} />
                  {t(`logic.importance.presets.${preset}`)}
                </label>
              ))}
            </RadioGroup>
            <p
              className="rounded-sm bg-muted/50 px-3 py-2 text-[13px] leading-relaxed text-muted-foreground"
              data-importance-explanation
            >
              {t(`logic.importance.explain.${config.preset}`)}
            </p>
          </fieldset>

          {config.preset === 'weighted' ? (
            <fieldset className="flex flex-col gap-4">
              <legend className="text-sm font-medium">{t('logic.importance.weightsTitle')}</legend>
              <p className="text-[13px] text-muted-foreground">
                {t('logic.importance.weightsHint')}
              </p>
              {shown.map(({ key, weight, attribute }) => {
                const name =
                  attribute === undefined ? t(`logic.importance.factors.${key}`) : attribute.name;
                const id = `weight-${key.replace('.', '-')}`;
                return (
                  <div key={key} className="flex flex-col gap-1" data-importance-weight={key}>
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor={id} className="text-sm font-medium">
                        {name}
                      </label>
                      <output htmlFor={id} className="text-sm tabular-nums">
                        {weight}
                      </output>
                    </div>
                    <input
                      id={id}
                      type="range"
                      min={0}
                      max={MAX_WEIGHT}
                      step={1}
                      value={weight}
                      aria-label={t('logic.importance.weight', { factor: name })}
                      className="h-6 w-full accent-primary max-md:h-11"
                      onChange={(event) => {
                        setConfig(withWeight(config, attributes, key, Number(event.target.value)));
                      }}
                    />
                    <p className="text-[13px] text-muted-foreground">
                      {attribute === undefined
                        ? t(`logic.importance.factorHelp.${key}`)
                        : t('logic.importance.factorHelp.attribute', { name: attribute.name })}
                    </p>
                  </div>
                );
              })}
            </fieldset>
          ) : null}

          <TopFive workspaceId={workspaceId} config={config} scope={dashboard.scope} />

          {error === null ? null : (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              className="max-md:h-11"
              disabled={applyOps.isPending}
              data-importance-save
              onClick={() => {
                void save(configToStore(config, attributes));
              }}
            >
              {applyOps.isPending ? t('logic.importance.saving') : t('logic.importance.save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="max-md:h-11"
              disabled={applyOps.isPending || dashboard.importance === null}
              onClick={() => {
                void save(null);
              }}
            >
              {t('logic.importance.reset')}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
