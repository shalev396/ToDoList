import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { LayoutGrid } from 'lucide-react';
import { useTemplates } from '@/api/queries/builder';
import { useCreateDashboard } from '@/api/queries/dashboards';
import { Button } from '@/components/ui/button';
import { dateLocale, timeOfDay } from '@/components/items/format';
import { useTemplateShareConfirm } from '@/features/templates/useTemplateShareConfirm';
import { EmptyIcon, EmptyState } from '@/features/shell/EmptyState';
import { topicById } from '@/features/workspaces/topics';
import { TopicIcon } from '@/features/workspaces/TopicIcon';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { useNow } from '@/hooks/useNow';
import type { BlockType } from '@api-types/builder';
import type { Role } from '@api-types/domain';
import type { WorkspaceView } from '@api-types/api-contracts';
import { ClockRing } from './blocks/clock/ClockRing';
import { blockEntry } from './registry';
import { templateFor, type DashboardListFilter } from './resolve';
import type { DashboardRoute } from './variables/routeBindings';

interface DashboardEmptyStateProps {
  workspace: WorkspaceView;
  role: Role;
  route: DashboardRoute;
  filter: DashboardListFilter;
}

/** Today on the ring, in the workspace's time zone: the main dashboard's empty visual. */
function TodayRing({ timeZone }: { timeZone: string }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const now = useNow();
  const locale = dateLocale(language);
  return (
    <ClockRing
      events={[]}
      now={now}
      timeZone={timeZone}
      size={168}
      labels={{
        summary: t('dashboard.clockSummary', { time: timeOfDay(now, locale, timeZone), timeZone }),
        eventList: t('dashboard.clockEvents'),
        describeEvent: () => '',
      }}
    />
  );
}

/** The ring on the main dashboard; a topic's icon on its pages. */
function RouteVisual({ route, timeZone }: { route: DashboardRoute; timeZone: string }) {
  return route.kind === 'main' ? <TodayRing timeZone={timeZone} /> : <TopicVisual route={route} />;
}

/** A topic page's icon (a folder for a topic without one). */
function TopicVisual({ route }: { route: Exclude<DashboardRoute, { kind: 'main' }> }) {
  const { topics } = useCurrentWorkspace();
  const topic = topicById(topics, route.topic.id);
  return (
    <EmptyIcon>
      <TopicIcon icon={topic?.icon ?? null} />
    </EmptyIcon>
  );
}

/** The template's blocks, each type once, as quiet chips. */
function TemplateBlocks({ types }: { types: readonly BlockType[] }) {
  const { t } = useTranslation();
  if (types.length === 0) {
    return null;
  }
  return (
    <ul aria-label={t('dashboard.empty.includes')} className="flex flex-wrap gap-1.5">
      {types.map((type) => {
        const Icon = blockEntry(type)?.icon ?? LayoutGrid;
        return (
          <li
            key={type}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-background px-2.5 text-[13px]"
          >
            <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
            {t(`blocks.types.${type}`)}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A route without a dashboard. Editors and owners start one from the route's template (its blocks
 * listed from the template gallery, so the promise matches what is created); viewers are told who
 * can set it up.
 */
export function DashboardEmptyState({ workspace, role, route, filter }: DashboardEmptyStateProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const canCreate = role === 'editor' || role === 'owner';
  const create = useCreateDashboard(workspace.id);
  const shareConfirm = useTemplateShareConfirm(workspace.id);
  const templates = useTemplates(workspace.id, canCreate);
  const choice = templateFor(route);
  const template = templates.data?.find((entry) => entry.key.split('@')[0] === choice.fromTemplate);
  const types = [...new Set(template?.blockTypes ?? [])];

  const visual = <RouteVisual route={route} timeZone={workspace.settings.timezone} />;

  if (!canCreate) {
    return (
      <EmptyState
        visual={visual}
        title={t('dashboard.empty.viewerTitle')}
        body={t('dashboard.empty.viewerBody', { workspace: workspace.name })}
      />
    );
  }

  let title: string;
  let body: string;
  switch (route.kind) {
    case 'main':
      title = t('dashboard.empty.mainTitle');
      body = t('dashboard.empty.createBody');
      break;
    case 'topic':
      title = t('dashboard.empty.topicTitle', { topic: route.topic.name });
      body = t('dashboard.empty.createBody');
      break;
    case 'group':
      title = t(
        route.topic.slug === 'college'
          ? 'dashboard.empty.courseTitle'
          : 'dashboard.empty.projectTitle',
      );
      body = t(
        route.topic.slug === 'college'
          ? 'dashboard.empty.courseBody'
          : 'dashboard.empty.projectBody',
      );
      break;
  }

  return (
    <EmptyState
      visual={visual}
      title={title}
      body={body}
      action={
        <div className="flex flex-col items-start gap-4">
          <TemplateBlocks types={types} />
          <Button
            disabled={create.isPending || shareConfirm.checking}
            onClick={() => {
              void (async () => {
                // The template never shares silently: ask first when it would attach some.
                const share = await shareConfirm.ask([choice.fromTemplate]);
                if (share === null) {
                  return;
                }
                create.mutate(
                  {
                    body: {
                      fromTemplate: choice.fromTemplate,
                      language: language === 'he' ? 'he' : 'en',
                      shareIntegrations: share.shareIntegrations,
                      ...(choice.scope === undefined ? {} : { scope: choice.scope }),
                    },
                    filter,
                  },
                  {
                    onError: () => {
                      toast.error(t('dashboard.empty.createFailed'));
                    },
                  },
                );
              })();
            }}
          >
            {create.isPending ? t('dashboard.empty.creating') : t('dashboard.empty.create')}
          </Button>
          {shareConfirm.dialog}
        </div>
      }
    />
  );
}
