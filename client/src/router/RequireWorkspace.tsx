import { Navigate, Outlet, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { PageSkeleton } from '@/features/shell/PageSkeleton';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { pathTo, ROUTES } from '@/router/routes';

/**
 * Pages that need a workspace. A signed-in user without one always goes to onboarding;
 * onboarding, invite links and the profile sit outside this guard.
 */
export default function RequireWorkspace() {
  const { t } = useTranslation();
  const { lng } = useParams<{ lng: string }>();
  const { workspace, workspaces, isLoading, isError, isSettling, refetch } = useCurrentWorkspace();

  // While a change settles no workspace is shown at all: never the previous one's data.
  if (isLoading || isSettling) {
    return <PageSkeleton />;
  }
  if (isError && workspaces.length === 0) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 px-4 py-10 md:px-8">
        <p className="text-sm text-muted-foreground">{t('app.page.loadError')}</p>
        <Button variant="outline" size="sm" onClick={refetch}>
          {t('app.page.retry')}
        </Button>
      </div>
    );
  }
  if (workspace === null) {
    return <Navigate to={pathTo(ROUTES.ONBOARDING, lng ?? 'en')} replace />;
  }
  return <Outlet />;
}
