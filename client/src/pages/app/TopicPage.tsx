import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { EyeOff } from 'lucide-react';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { buttonVariants } from '@/components/ui/button-variants';
import { pageTitle } from '@/data/pageTitles';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import { topicBySlug } from '@/features/workspaces/topics';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { DashboardPage } from '@/features/dashboards/DashboardPage';
import { DashboardSkeleton } from '@/features/dashboards/DashboardSkeleton';
import type { DashboardRoute, RouteTopic } from '@/features/dashboards/variables/routeBindings';
import { EmptyIcon, EmptyState } from '@/features/shell/EmptyState';
import { PageContainer, PageHeader } from '@/features/shell/PageHeader';

function TopicDashboard({ id, slug, name, group }: RouteTopic & { group: string | undefined }) {
  const route = useMemo<DashboardRoute>(() => {
    const topic = { id, slug, name };
    return group === undefined ? { kind: 'topic', topic } : { kind: 'group', topic, group };
  }, [id, slug, name, group]);
  return <DashboardPage route={route} />;
}

/**
 * A topic (`t/:topic`, by its slug) or one group in it (`t/:topic/:group`): its dashboard. A slug
 * the workspace has no topic for (never made, or deleted) says so instead of showing a page.
 */
export default function TopicPage() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { topic: slug = '', group } = useParams<{ topic: string; group?: string }>();
  const { workspace, topics, topicsLoading } = useCurrentWorkspace();

  const topic = topicBySlug(topics, slug);

  if (topic === null && (workspace === null || topicsLoading)) {
    return <DashboardSkeleton />;
  }

  if (topic === null) {
    return (
      <PageContainer>
        <PageMetadata title={pageTitle(t('app.topic.missingTitle'))} noIndex />
        <PageHeader title={t('app.topic.missingTitle')} />
        <EmptyState
          visual={
            <EmptyIcon>
              <EyeOff aria-hidden="true" />
            </EmptyIcon>
          }
          title={t('app.topic.missingTitle')}
          body={t('app.topic.missingBody', { workspace: workspace?.name ?? '' })}
          action={
            <Link
              to={pathTo(ROUTES.DASHBOARD, language)}
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('app.topic.backToDashboard')}
            </Link>
          }
        />
      </PageContainer>
    );
  }

  return <TopicDashboard id={topic.id} slug={topic.slug} name={topic.name} group={group} />;
}
