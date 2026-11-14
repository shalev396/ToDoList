import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { apiConflictVersion, errorMessage } from '@/api/errors';
import { useBuilderCatalog } from '@/api/queries/builder';
import { useApplyDashboardOps } from '@/api/queries/dashboards';
import { useFacets } from '@/api/queries/items';
import { useIntegrationSharing, useIntegrations } from '@/api/queries/integrations';
import { useMembers } from '@/api/queries/members';
import { queryKeys } from '@/api/queries/keys';
import { useViews } from '@/api/queries/views';
import { validateDraft as validateOnServer } from '@/api/services/builderService';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { blockEntry } from '@/features/dashboards/registry';
import type { Block, BlockType, CatalogDescription } from '@api-types/builder';
import type { DashboardIssue, DashboardView } from '@api-types/dashboards';
import {
  addBlockOp,
  connectorProviders,
  dashboardDraftWith,
  draftFromBlock,
  draftFromDefaults,
  issuesForBlock,
  offeredVariables,
  previewRequest,
  updateBlockOp,
  validateDraft,
  type BlockDraft,
} from './draft';
import { GroupStep } from './GroupStep';
import { Preview } from './Preview';
import { useDebounced } from './useDebounced';
import { FilterStep, SourceStep, type ConnectorContext } from './SourceFilterSteps';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { VizStep } from './VizStep';

/** `viewId`: add the block to that dashboard view's grid instead of the Summary's. */
export type EditorTarget = { mode: 'add'; viewId?: string } | { mode: 'edit'; blockId: string };

type StepId = 'source' | 'filter' | 'group' | 'viz';
const QUERY_STEPS: readonly StepId[] = ['source', 'filter', 'group', 'viz'];
const LINT_DEBOUNCE_MS = 600;

interface BlockEditorSheetProps {
  workspaceId: string;
  dashboard: DashboardView;
  target: EditorTarget;
  language: 'en' | 'he';
  /** Saves layout changes still waiting, so the write below starts from the newest version. */
  flush: () => void;
  onClose: () => void;
}

function TypePicker({
  catalog,
  onPick,
}: {
  catalog: CatalogDescription;
  onPick: (type: BlockType) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t('editor.typeHint')}</p>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {catalog.blockTypes.map(({ type }) => {
          const Icon = blockEntry(type)?.icon;
          return (
            <li key={type}>
              <button
                type="button"
                data-block-type={type}
                onClick={() => {
                  onPick(type);
                }}
                className="flex min-h-11 w-full items-center gap-2.5 rounded-md border bg-card px-3 py-2.5 text-start text-sm transition-colors hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {Icon === undefined ? null : (
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                )}
                {t(`blocks.types.${type}`)}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function IssueList({
  issues,
}: {
  issues: { severity: 'error' | 'warning'; code: string; pointer: string }[];
}) {
  const { t } = useTranslation();
  if (issues.length === 0) {
    return null;
  }
  return (
    <ul data-editor-issues className="flex flex-col gap-1.5" aria-label={t('editor.issues.title')}>
      {issues.map((issue, index) => (
        <li
          key={`${issue.code}-${issue.pointer}-${String(index)}`}
          data-issue={issue.severity}
          className={
            issue.severity === 'error'
              ? 'flex items-start gap-2 text-[13px] text-destructive'
              : 'flex items-start gap-2 text-[13px] text-muted-foreground'
          }
        >
          {issue.severity === 'error' ? (
            <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span>
            {t(`editor.issues.${issue.code}`, { defaultValue: t('editor.issues.unknown') })}
            {issue.pointer === '' ? null : (
              <code className="ms-1.5 text-[12px]" dir="ltr">
                {issue.pointer.replace(/^\/blocks\/\d+/, '') || '/'}
              </code>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The block editor (FRONTEND.md §6): a right Sheet in four steps, Source → Filter → Group → Viz,
 * with a live preview. Saves as one `add_block` / `update_block` op against the version shown;
 * a 409 keeps this open with the draft, refetches, and offers to re-apply it.
 */
const NOTHING_SHARED: ReadonlySet<string> = new Set();

export function BlockEditorSheet({
  workspaceId,
  dashboard,
  target,
  language,
  flush,
  onClose,
}: BlockEditorSheetProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const catalog = useBuilderCatalog(workspaceId);
  const facets = useFacets(workspaceId);
  const integrations = useIntegrations(workspaceId);
  const sharing = useIntegrationSharing(workspaceId);
  const members = useMembers(workspaceId);
  const { workspace } = useCurrentWorkspace();
  const views = useViews(workspaceId);
  const applyOps = useApplyDashboardOps(workspaceId, dashboard.id);
  const original: Block | undefined =
    target.mode === 'edit'
      ? dashboard.blocks.find((block) => block.id === target.blockId)
      : undefined;
  // A source that was removed (its integration is gone) leaves the block with this edit.
  const [draft, setDraft] = useState<BlockDraft | null>(() =>
    original === undefined
      ? null
      : draftFromBlock(
          original,
          new Set(
            Object.entries(dashboard.connectors)
              .filter(([, info]) => info.removed)
              .map(([id]) => id),
          ),
        ),
  );
  const connectorContext = useMemo<ConnectorContext>(() => {
    const names = new Map(
      (members.data ?? []).map((member) => [
        member.userId,
        member.name ?? member.email ?? t('editor.source.aMember'),
      ]),
    );
    const own = new Map(
      (integrations.data ?? []).map((integration) => [integration.id, integration.provider]),
    );
    return {
      info: dashboard.connectors,
      memberName: (userId) => names.get(userId) ?? t('editor.source.aMember'),
      workspaceName: workspace?.name ?? '',
      // Until it loads, nothing counts as shared: adding asks first.
      shared: sharing.data ?? NOTHING_SHARED,
      providerOf: (id) => {
        const info = dashboard.connectors[id];
        return (
          own.get(id) ??
          (info === undefined || info.removed ? undefined : (info.provider ?? undefined))
        );
      },
    };
  }, [dashboard.connectors, integrations.data, members.data, sharing.data, t, workspace?.name]);
  const [step, setStep] = useState<StepId>('source');
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const edit = (patch: Partial<BlockDraft>) => {
    setDraft((current) => (current === null ? current : { ...current, ...patch }));
    setSaveError(null);
  };

  const entry =
    draft === null ? undefined : catalog.data?.blockTypes.find((e) => e.type === draft.type);
  const hasQuery = draft !== null && (entry?.requiredQuery === true || draft.query !== undefined);
  const steps: readonly StepId[] = hasQuery ? QUERY_STEPS : ['viz'];
  const current: StepId = steps.includes(step) ? step : 'viz';
  const index = steps.indexOf(current);
  const variables = useMemo(
    () => (draft === null ? [] : offeredVariables(dashboard.vars, draft)),
    [dashboard.vars, draft],
  );

  const clientIssues = useMemo(() => (draft === null ? [] : validateDraft(draft)), [draft]);
  const lintBody = useMemo(() => {
    if (draft === null || clientIssues.length > 0) {
      return null;
    }
    return dashboardDraftWith(dashboard, draft, target.mode === 'edit' ? target.blockId : null);
  }, [dashboard, draft, clientIssues.length, target]);
  const lintKey = useDebounced(lintBody === null ? '' : JSON.stringify(lintBody), LINT_DEBOUNCE_MS);
  const lint = useQuery({
    queryKey: [...queryKeys.dashboards(workspaceId), 'lint', lintKey],
    enabled: lintKey !== '',
    retry: false,
    gcTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const body = JSON.parse(lintKey) as NonNullable<typeof lintBody>;
      const response = await validateOnServer(
        workspaceId,
        { draft: body.draft },
        { signal, suppressErrorToast: true },
      );
      return { result: response.data, index: body.index };
    },
  });

  const issues = useMemo(() => {
    const own: { severity: 'error' | 'warning'; code: string; pointer: string }[] =
      clientIssues.map((issue) => ({
        severity: 'error',
        code: 'invalid',
        pointer: `/blocks/0${issue.pointer}`,
      }));
    if (lint.data !== undefined) {
      const tag = (list: DashboardIssue[], severity: 'error' | 'warning') =>
        issuesForBlock(list, lint.data.index).map((issue) => ({
          severity,
          code: issue.code,
          pointer: issue.pointer,
        }));
      own.push(
        ...tag(lint.data.result.errors, 'error'),
        ...tag(lint.data.result.warnings, 'warning'),
      );
    }
    return own;
  }, [clientIssues, lint.data]);
  const blocked = issues.some((issue) => issue.severity === 'error');

  const save = async () => {
    if (draft === null) {
      return;
    }
    const op =
      target.mode === 'add'
        ? addBlockOp(draft, target.viewId)
        : original === undefined
          ? null
          : updateBlockOp(original.id, draft, original);
    if (op === null) {
      onClose();
      return;
    }
    flush();
    setSaving(true);
    setSaveError(null);
    const draftKey = queryKeys.dashboard(workspaceId, dashboard.id, 'draft');
    const expectedVersion =
      queryClient.getQueryData<DashboardView>(draftKey)?.version ?? dashboard.version;
    try {
      await applyOps.mutateAsync({ expectedVersion, ops: [op], language });
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
      toast.success(t(target.mode === 'add' ? 'editor.added' : 'editor.saved'));
      onClose();
    } catch (failure) {
      if (apiConflictVersion(failure) !== null) {
        // Changed elsewhere: bring the fresh copy in and keep this draft for a re-apply.
        setConflict(true);
        toast.error(t('editor.conflictToast'));
        await queryClient.invalidateQueries({
          queryKey: queryKeys.dashboardCopies(workspaceId, dashboard.id),
        });
      } else {
        setSaveError(errorMessage(t, failure, 'editor.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const pick = (type: BlockType) => {
    const found = catalog.data?.blockTypes.find((e) => e.type === type);
    if (found !== undefined) {
      setDraft(
        draftFromDefaults({
          type,
          defaults: found.defaults,
        }),
      );
      setStep(found.requiredQuery || found.defaults.query !== undefined ? 'source' : 'viz');
    }
  };

  const missingBlock = target.mode === 'edit' && original === undefined && draft === null;

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
        side="end"
        closeLabel={t('editor.close')}
        data-block-editor
        aria-describedby={undefined}
        className="w-full gap-0 sm:max-w-xl"
      >
        <SheetHeader className="border-b pe-14">
          <SheetTitle>
            {t(target.mode === 'add' ? 'editor.addTitle' : 'editor.editTitle')}
          </SheetTitle>
          <p className="text-[13px] text-muted-foreground">{t('editor.description')}</p>
        </SheetHeader>

        {catalog.data === undefined ? (
          <div className="flex flex-col gap-3 p-4">
            {catalog.isError ? (
              <>
                <p role="alert" className="text-sm text-destructive">
                  {t('editor.catalogError')}
                </p>
                <Button
                  variant="outline"
                  className="w-fit"
                  onClick={() => {
                    void catalog.refetch();
                  }}
                >
                  {t('dashboard.retry')}
                </Button>
              </>
            ) : (
              <>
                <Skeleton className="h-8 w-2/3" />
                <Skeleton className="h-32" />
              </>
            )}
          </div>
        ) : missingBlock ? (
          <p role="alert" className="p-4 text-sm text-destructive">
            {t('editor.blockGone')}
          </p>
        ) : draft === null ? (
          <div className="overflow-y-auto p-4">
            <TypePicker catalog={catalog.data} onPick={pick} />
          </div>
        ) : (
          <>
            <nav aria-label={t('editor.steps.label')} className="border-b px-4">
              <ol className="flex gap-1 overflow-x-auto">
                {steps.map((id, position) => (
                  <li key={id}>
                    <button
                      type="button"
                      data-editor-step={id}
                      aria-current={id === current ? 'step' : undefined}
                      onClick={() => {
                        setStep(id);
                      }}
                      className={
                        id === current
                          ? 'inline-flex min-h-11 items-center border-b-2 border-foreground px-2.5 text-sm font-medium pointer-fine:min-h-10'
                          : 'inline-flex min-h-11 items-center border-b-2 border-transparent px-2.5 text-sm text-muted-foreground hover:text-foreground pointer-fine:min-h-10'
                      }
                    >
                      {position + 1}. {t(`editor.steps.${id}`)}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>

            <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
              {conflict ? (
                <p
                  role="alert"
                  data-editor-conflict
                  className="flex items-start gap-2 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
                >
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  {t('editor.conflict')}
                </p>
              ) : null}
              {current === 'source' ? (
                <SourceStep
                  draft={draft}
                  onChange={edit}
                  catalog={catalog.data}
                  facets={facets.data}
                  integrations={integrations.data}
                  views={views.data}
                  connectorContext={connectorContext}
                />
              ) : null}
              {current === 'filter' ? (
                <FilterStep
                  draft={draft}
                  onChange={edit}
                  catalog={catalog.data}
                  variables={variables}
                  providers={connectorProviders(draft.connectors, connectorContext.providerOf)}
                />
              ) : null}
              {current === 'group' ? (
                <GroupStep draft={draft} onChange={edit} catalog={catalog.data} />
              ) : null}
              {current === 'viz' ? (
                <VizStep
                  draft={draft}
                  onChange={edit}
                  catalog={catalog.data}
                  variables={variables}
                />
              ) : null}
              {hasQuery ? (
                <Preview
                  workspaceId={workspaceId}
                  request={previewRequest(draft, dashboard.vars)}
                />
              ) : null}
            </div>

            <div className="flex flex-col gap-3 border-t p-4">
              <IssueList issues={issues} />
              {saveError === null ? null : (
                <p role="alert" className="text-[13px] text-destructive">
                  {saveError}
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    className="max-md:h-11"
                    disabled={index === 0}
                    onClick={() => {
                      setStep(steps[index - 1] ?? current);
                    }}
                  >
                    {t('editor.back')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="max-md:h-11"
                    disabled={index === steps.length - 1}
                    onClick={() => {
                      setStep(steps[index + 1] ?? current);
                    }}
                  >
                    {t('editor.next')}
                  </Button>
                </div>
                <Button
                  type="button"
                  data-editor-save
                  className="max-md:h-11"
                  disabled={saving || blocked}
                  onClick={() => void save()}
                >
                  {t(
                    saving
                      ? 'editor.saving'
                      : conflict
                        ? 'editor.reapply'
                        : target.mode === 'add'
                          ? 'editor.add'
                          : 'editor.save',
                  )}
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
