import { useEffect, useRef } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { buttonVariants } from '@/components/ui/button-variants';
import { pageTitle } from '@/data/pageTitles';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import { selectCurrentWorkspaceId } from '@/store/workspaceSlice';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useSwitchWorkspace } from '@/features/workspaces/useSwitchWorkspace';
import { EmptyIcon, EmptyState } from '@/features/shell/EmptyState';
import { PageContainer, PageHeader } from '@/features/shell/PageHeader';
import { PageSkeleton } from '@/features/shell/PageSkeleton';

/**
 * A local item's source link (`w/:wid/items/:id`). For a member, it switches to that workspace
 * (with the usual reset) and opens the dashboard with the item (`?item=`). Others learn they
 * can't open it.
 */
export default function ItemLinkPage() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { wid = '', id = '' } = useParams<{ wid: string; id: string }>();
  const currentId = useSelector(selectCurrentWorkspaceId);
  const { workspaces, isLoading } = useCurrentWorkspace();
  const switchWorkspace = useSwitchWorkspace();
  const switched = useRef(false);
  const isMember = workspaces.some((entry) => entry.workspace.id === wid);
  const target = `${pathTo(ROUTES.DASHBOARD, language)}?item=${encodeURIComponent(id)}`;

  useEffect(() => {
    if (isMember && currentId !== wid && !switched.current) {
      switched.current = true;
      switchWorkspace(wid, { navigate: false });
    }
  }, [isMember, currentId, wid, switchWorkspace]);

  if (isLoading) {
    return <PageSkeleton />;
  }
  if (isMember) {
    return currentId === wid ? <Navigate to={target} replace /> : <PageSkeleton />;
  }
  return (
    <PageContainer>
      <PageMetadata title={pageTitle(t('app.itemLink.title'))} noIndex />
      <PageHeader title={t('app.itemLink.title')} />
      <EmptyState
        visual={
          <EmptyIcon>
            <Lock aria-hidden="true" />
          </EmptyIcon>
        }
        title={t('app.itemLink.title')}
        body={t('app.itemLink.body')}
        action={
          <Link
            to={pathTo(ROUTES.DASHBOARD, language)}
            className={buttonVariants({ variant: 'outline' })}
          >
            {t('app.itemLink.action')}
          </Link>
        }
      />
    </PageContainer>
  );
}
