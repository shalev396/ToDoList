import { lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Check,
  CircleAlert,
  FilePen,
  Gauge,
  LayoutGrid,
  Pencil,
  Plus,
  Redo2,
  Undo2,
} from 'lucide-react';
import { useDashboard, useDashboards } from '@/api/queries/dashboards';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { Button } from '@/components/ui/button';
import { SaveStatus } from '@/components/ui/save-status';
import { buttonVariants } from '@/components/ui/button-variants';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { dateLocale, longDate } from '@/components/items/format';
import { pageTitle } from '@/data/pageTitles';
import { EmptyIcon, EmptyState } from '@/features/shell/EmptyState';
import { PageContainer, PageHeader } from '@/features/shell/PageHeader';
import { ImportanceSettings } from './importance/ImportanceSettings';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { useNow } from '@/hooks/useNow';
import { pathTo, ROUTES, topicPath } from '@/router/routes';
import type { WorkspaceView } from '@api-types/api-contracts';
import { CAPS } from '@api-types/builder';
import type { DashboardCopy, DashboardView } from '@api-types/dashboards';
import type { Role } from '@api-types/domain';
import { DashboardEmptyState } from './DashboardEmptyState';
import { DashboardGrid } from './DashboardGrid';
import { DashboardSkeleton } from './DashboardSkeleton';
import type { EditorTarget } from '@/features/editor/BlockEditorSheet';
import { useDashboardEditor, type DashboardEditor } from './editor/useDashboardEditor';
import { useGridBreakpoint } from './grid/useGridBreakpoint';
import { dashboardListFilter, pickDashboard } from './resolve';
import { VarOutlineProvider } from './VarOutline';
import { ItemSheet } from '@/features/items/ItemSheet';
import { PageVarsProvider } from './variables/PageVarsProvider';
import { PageVarsPanel } from './variables/PageVarsPanel';
import { AddViewDialog } from '@/features/views/AddViewDialog';
import { RigidView } from '@/features/views/RigidView';
import { useViewActions } from '@/features/views/useViewActions';
import { ViewTabs } from '@/features/views/ViewTabs';
import {
  canAddBlock,
  isRigidViewType,
  layoutsOfBlocks,
  resolveView,
  rigidBlock,
  scopedDashboard,
  SUMMARY_VIEW_ID,
  VIEW_PARAM,
} from '@/features/views/viewModel';
import type { DashboardRoute } from './variables/routeBindings';

/** The page's own params (urlVars.ts RESERVED_PARAMS): edit mode and the copy shown. */
// The block editor (and react-querybuilder with it) loads when it is first opened.
const BlockEditorSheet = lazy(() =>
  import('@/features/editor/BlockEditorSheet').then((module) => ({
    default: module.BlockEditorSheet,
  })),
);

const EDIT_PARAM = 'edit';
const COPY_PARAM = 'as';
const DASHBOARD_PARAM = 'dashboard';

function canEditAs(role: Role): boolean {
  return role === 'editor' || role === 'owner';
}

/** The heading of a route that has no dashboard yet. */
function useRouteHeading(route: DashboardRoute): string {
  const { t } = useTranslation();
  switch (route.kind) {
    case 'main':
      return t('dashboard.title');
    case 'topic':
      return route.topic.name;
    case 'group':
      return t(
        route.topic.slug === 'college'
          ? 'dashboard.groupTitle.course'
          : 'dashboard.groupTitle.project',
      );
  }
}

function LoadError({ heading, onRetry }: { heading: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <PageContainer>
      <PageMetadata title={pageTitle(heading)} noIndex />
      <PageHeader title={heading} />
      <EmptyState
        visual={
          <EmptyIcon>
            <CircleAlert aria-hidden="true" />
          </EmptyIcon>
        }
        title={t('dashboard.loadError')}
        body={t('dashboard.loadErrorBody')}
        action={
          <Button variant="outline" onClick={onRetry}>
            {t('dashboard.retry')}
          </Button>
        }
      />
    </PageContainer>
  );
}

function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button gets no pointer events: the span keeps the name reachable. */}
        <span className="inline-flex">
          <Button
            variant="ghost"
            size="icon-sm"
            className="max-md:size-11"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Edit for editors and owners; while editing, the save state, Undo, Redo and Done. */
function DashboardActions({
  editing,
  editor,
  onEdit,
  onImportance,
  onAdd,
  canAdd,
  onDone,
}: {
  editing: boolean;
  editor: DashboardEditor;
  onEdit: () => void;
  onImportance: () => void;
  /** null: this view has no grid (a rigid view), so there is no block to add. */
  onAdd: (() => void) | null;
  canAdd: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  if (!editing) {
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          className="max-md:h-11"
          data-open-importance
          onClick={onImportance}
        >
          <Gauge aria-hidden="true" />
          {t('logic.importance.open')}
        </Button>
        <Button variant="outline" size="sm" className="max-md:h-11" onClick={onEdit}>
          <Pencil aria-hidden="true" />
          {t('dashboard.edit')}
        </Button>
      </>
    );
  }
  return (
    <>
      {/* Always reserves its room and is announced; on phones it comes after the buttons, so
          they never move. */}
      <SaveStatus state={editor.status} className="order-last sm:order-first" />
      {onAdd === null ? null : (
        <Button
          variant="outline"
          size="sm"
          className="max-md:h-11"
          data-add-block
          disabled={!canAdd}
          title={canAdd ? undefined : t('views.blocksFull', { count: CAPS.maxBlocks })}
          onClick={onAdd}
        >
          <Plus aria-hidden="true" />
          {t('dashboard.addBlock')}
        </Button>
      )}
      <IconAction label={t('dashboard.undo')} disabled={!editor.canUndo} onClick={editor.undo}>
        <Undo2 aria-hidden="true" className="rtl:-scale-x-100" />
      </IconAction>
      <IconAction label={t('dashboard.redo')} disabled={!editor.canRedo} onClick={editor.redo}>
        <Redo2 aria-hidden="true" className="rtl:-scale-x-100" />
      </IconAction>
      <Button size="sm" className="max-md:h-11" onClick={onDone}>
        <Check aria-hidden="true" />
        {t('dashboard.done')}
      </Button>
    </>
  );
}

/** A refetch failed: the page keeps the copy it has and says so, quietly, with a retry. */
function RefreshFailedNote({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <p role="status" className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
      <span>{t('dashboard.refreshFailed')}</span>
      <Button
        variant="link"
        size="sm"
        className="h-auto min-h-6 px-1 text-[13px] max-md:min-h-11"
        onClick={onRetry}
      >
        {t('dashboard.retry')}
      </Button>
    </p>
  );
}

interface LoadedDashboardProps {
  workspace: WorkspaceView;
  role: Role;
  route: DashboardRoute;
  dashboard: DashboardView;
  copy: DashboardCopy;
  /** The last refetch failed (the dashboard shown is the last copy loaded): retry it. */
  onRetryRefresh: (() => void) | null;
}

function LoadedDashboard({
  workspace,
  role,
  route,
  dashboard,
  copy,
  onRetryRefresh,
}: LoadedDashboardProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const now = useNow();
  const breakpoint = useGridBreakpoint();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [importanceOpen, setImportanceOpen] = useState(false);
  const [addingView, setAddingView] = useState(false);
  // Edit mode is only ever offered on the draft, to editors and owners; a viewer opening ?edit=1
  // just gets the view.
  const canEdit = copy === 'draft' && canEditAs(role);
  const editing = canEdit && searchParams.get(EDIT_PARAM) === '1';
  const editor = useDashboardEditor({
    workspaceId: workspace.id,
    dashboard,
    isOwner: role === 'owner',
    active: canEdit,
    editing,
  });

  const view = resolveView(dashboard, searchParams.get(VIEW_PARAM));
  const activeViewId = view?.id ?? SUMMARY_VIEW_ID;
  const lang = language === 'he' ? 'he' : 'en';
  const viewActions = useViewActions({
    workspaceId: workspace.id,
    dashboard,
    language: lang,
    flush: editor.flush,
  });
  // The page as this view shows it: the Summary's blocks, a dashboard view's, or a rigid view's one.
  const shown = useMemo(() => scopedDashboard(dashboard, view), [dashboard, view]);
  const rigid = view === null ? null : rigidBlock(dashboard, view);
  const gridLayouts = useMemo(
    () => layoutsOfBlocks(canEdit ? editor.layouts : dashboard.layouts, shown.dashboard.blocks),
    [canEdit, editor.layouts, dashboard.layouts, shown.dashboard.blocks],
  );

  const selectView = useCallback(
    (viewId: string) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (viewId === SUMMARY_VIEW_ID) {
            next.delete(VIEW_PARAM);
          } else {
            next.set(VIEW_PARAM, viewId);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setEditing = useCallback(
    (on: boolean) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (on) {
            next.set(EDIT_PARAM, '1');
          } else {
            next.delete(EDIT_PARAM);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // An editor's changes wait for an owner to publish them; owners publish as they save.
  const waitsForOwner =
    role === 'editor' && copy === 'draft' && dashboard.publishedVersion !== dashboard.version;
  const description = editing
    ? t(breakpoint === 'sm' ? 'dashboard.editHintPhone' : 'dashboard.editHint')
    : longDate(now, dateLocale(language), workspace.settings.timezone);

  return (
    <PageContainer>
      <PageMetadata title={pageTitle(dashboard.title)} noIndex />
      <PageVarsProvider dashboard={dashboard} route={route}>
        <PageHeader
          title={dashboard.title}
          description={description}
          actions={
            canEdit ? (
              <DashboardActions
                editing={editing}
                editor={editor}
                onEdit={() => {
                  setEditing(true);
                }}
                onImportance={() => {
                  setImportanceOpen(true);
                }}
                canAdd={canAddBlock(dashboard, view)}
                onAdd={
                  view !== null && isRigidViewType(view.type)
                    ? null
                    : () => {
                        setEditorTarget(
                          view === null ? { mode: 'add' } : { mode: 'add', viewId: view.id },
                        );
                      }
                }
                onDone={() => {
                  editor.flush();
                  setEditing(false);
                }}
              />
            ) : undefined
          }
        >
          {waitsForOwner ? (
            <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <FilePen aria-hidden="true" className="size-3.5 shrink-0" />
              {t('dashboard.draftNote')}
            </p>
          ) : undefined}
          {onRetryRefresh === null ? undefined : <RefreshFailedNote onRetry={onRetryRefresh} />}
        </PageHeader>
        <ViewTabs
          dashboard={dashboard}
          activeId={activeViewId}
          onSelect={selectView}
          canEdit={canEdit}
          editing={editing}
          actions={{
            ...viewActions,
            removeView: async (viewId) => {
              const removed = await viewActions.removeView(viewId);
              if (removed && viewId === activeViewId) {
                selectView(SUMMARY_VIEW_ID);
              }
              return removed;
            },
          }}
          onAdd={() => {
            setAddingView(true);
          }}
        />
        <div
          id="view-panel"
          role="tabpanel"
          aria-labelledby={`view-tab-${activeViewId}`}
          data-view-panel={activeViewId}
          className={editing ? 'grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]' : undefined}
        >
          <div className="min-w-0">
            {rigid !== null ? (
              <RigidView
                dashboard={dashboard}
                block={rigid}
                editing={editing}
                onEdit={(blockId) => {
                  setEditorTarget({ mode: 'edit', blockId });
                }}
              />
            ) : shown.dashboard.blocks.length === 0 ? (
              <EmptyState
                visual={
                  <EmptyIcon>
                    <LayoutGrid aria-hidden="true" />
                  </EmptyIcon>
                }
                title={t(canEdit ? 'dashboard.empty.blankTitle' : 'dashboard.empty.noBlocksTitle')}
                body={t(canEdit ? 'dashboard.empty.blankBody' : 'dashboard.empty.noBlocksBody')}
                action={
                  canEdit ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        onClick={() => {
                          setEditing(true);
                          setEditorTarget(
                            view === null ? { mode: 'add' } : { mode: 'add', viewId: view.id },
                          );
                        }}
                      >
                        <Plus aria-hidden="true" />
                        {t('dashboard.addBlock')}
                      </Button>
                      {view === null ? (
                        <Link
                          to={pathTo(ROUTES.TEMPLATES, language)}
                          className={buttonVariants({ variant: 'outline' })}
                        >
                          {t('dashboard.empty.useTemplate')}
                        </Link>
                      ) : null}
                    </div>
                  ) : undefined
                }
              />
            ) : (
              <VarOutlineProvider blocks={shown.dashboard.blocks}>
                <DashboardGrid
                  dashboard={shown.dashboard}
                  layouts={gridLayouts}
                  editing={editing}
                  onCommit={editor.commitLayout}
                  onRemoveBlock={editor.removeBlock}
                  onEditBlock={(blockId) => {
                    setEditorTarget({ mode: 'edit', blockId });
                  }}
                />
              </VarOutlineProvider>
            )}
          </div>
          {editing ? <PageVarsPanel dashboard={dashboard} /> : null}
        </div>
        <ItemSheet />
        {canEdit && addingView ? (
          <AddViewDialog
            workspaceId={workspace.id}
            language={lang}
            actions={viewActions}
            onClose={() => {
              setAddingView(false);
            }}
            onAdded={(added) => {
              selectView(added.id);
            }}
          />
        ) : null}
        {canEdit && importanceOpen ? (
          <ImportanceSettings
            workspaceId={workspace.id}
            dashboard={dashboard}
            language={language === 'he' ? 'he' : 'en'}
            onClose={() => {
              setImportanceOpen(false);
            }}
          />
        ) : null}
        {canEdit && editing && editorTarget !== null ? (
          <Suspense fallback={null}>
            <BlockEditorSheet
              key={editorTarget.mode === 'edit' ? editorTarget.blockId : 'new'}
              workspaceId={workspace.id}
              dashboard={dashboard}
              target={editorTarget}
              language={language === 'he' ? 'he' : 'en'}
              flush={editor.flush}
              onClose={() => {
                setEditorTarget(null);
              }}
            />
          </Suspense>
        ) : null}
      </PageVarsProvider>
    </PageContainer>
  );
}

function DashboardLoader({
  workspace,
  role,
  route,
  dashboardId,
}: {
  workspace: WorkspaceView;
  role: Role;
  route: DashboardRoute;
  dashboardId: string;
}) {
  const [searchParams] = useSearchParams();
  const heading = useRouteHeading(route);
  // Editors work on the draft and may look at the published copy (`?as=published`); viewers only
  // ever get the published one.
  const copy: DashboardCopy =
    canEditAs(role) && searchParams.get(COPY_PARAM) !== 'published' ? 'draft' : 'published';
  const query = useDashboard(workspace.id, dashboardId, copy);
  const retry = () => {
    void query.refetch();
  };
  // Whatever was loaded stays on screen: only a first load that fails is an error page (a
  // failed refetch must not hide the grid, or the edits in it).
  if (query.data === undefined) {
    return query.isError ? <LoadError heading={heading} onRetry={retry} /> : <DashboardSkeleton />;
  }
  return (
    <LoadedDashboard
      workspace={workspace}
      role={role}
      route={route}
      dashboard={query.data}
      copy={copy}
      onRetryRefresh={query.isRefetchError ? retry : null}
    />
  );
}

function RouteDashboard({
  workspace,
  role,
  route,
}: {
  workspace: WorkspaceView;
  role: Role;
  route: DashboardRoute;
}) {
  const [searchParams] = useSearchParams();
  const heading = useRouteHeading(route);
  const filter = useMemo(() => dashboardListFilter(route), [route]);
  const list = useDashboards(workspace.id, filter);
  const { topics } = useCurrentWorkspace();
  const { language } = useLanguage();
  if (list.data === undefined) {
    return list.isError ? (
      <LoadError
        heading={heading}
        onRetry={() => {
          void list.refetch();
        }}
      />
    ) : (
      <DashboardSkeleton />
    );
  }
  // `?dashboard=<id>` shows that page (a template just made it), whatever the route would pick.
  const wanted = searchParams.get(DASHBOARD_PARAM);
  const picked = wanted === null ? pickDashboard(list.data, route) : { id: wanted };
  // A workspace starts with one topic page and no main dashboard (D1): with a single topic and no
  // main dashboard, that topic is home.
  const [onlyTopic] = topics;
  if (picked === null && route.kind === 'main' && topics.length === 1 && onlyTopic !== undefined) {
    return <Navigate to={pathTo(topicPath(onlyTopic.slug), language)} replace />;
  }
  if (picked === null) {
    return (
      <PageContainer>
        <PageMetadata title={pageTitle(heading)} noIndex />
        <PageHeader title={heading} />
        <DashboardEmptyState workspace={workspace} role={role} route={route} filter={filter} />
      </PageContainer>
    );
  }
  return (
    <DashboardLoader
      key={picked.id}
      workspace={workspace}
      role={role}
      route={route}
      dashboardId={picked.id}
    />
  );
}

/**
 * The dashboard of a route (FRONTEND.md §1, §5): the main one on `/dashboard`, a topic's on
 * `/t/:topic`, a group's on `/t/:topic/:group` (resolve.ts), with its page variables, its grid and,
 * for editors and owners, edit mode with autosave. Without a dashboard, editors and owners start
 * one from a template and viewers see a quiet empty state.
 */
export function DashboardPage({ route }: { route: DashboardRoute }) {
  const { workspace, role } = useCurrentWorkspace();
  if (workspace === null || role === null) {
    return <DashboardSkeleton />;
  }
  return <RouteDashboard workspace={workspace} role={role} route={route} />;
}
