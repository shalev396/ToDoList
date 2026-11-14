import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CircleAlert, Link2 } from 'lucide-react';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { pageTitle } from '@/data/pageTitles';
import { limits } from '@/data/limits';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { useAcceptJoinLink } from '@/api/queries/invites';
import { queryKeys } from '@/api/queries/keys';
import { apiErrorCode, apiErrorStatus } from '@/api/errors';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import { selectUser } from '@/store/userSlice';
import { useSwitchWorkspace } from '@/features/workspaces/useSwitchWorkspace';
import type { ListWorkspacesResponseData } from '@api-types/api-contracts';

type JoinFailure = 'gone' | 'alreadyMember' | 'workspaceFull' | 'unknown';

/** The join page's failures: 404 (unknown, reset or switched off), 409 by code, anything else. */
function joinFailureFor(status: number | undefined, code: string | undefined): JoinFailure {
  if (code === 'already_member') {
    return 'alreadyMember';
  }
  if (code === 'workspace_full') {
    return 'workspaceFull';
  }
  if (status === 404 || status === 410) {
    return 'gone';
  }
  return 'unknown';
}

/**
 * A join link (`join/:token`, "anyone with the link"). Signed-out visitors log in first and come
 * back (ProtectedRoute `next`); any email will do. Accepting joins as the link's role (viewer or
 * editor), makes the workspace current and opens its dashboard. The token stays in this page's URL
 * only; it is sent in the request body and never stored or logged.
 */
export default function JoinLinkPage() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { token = '' } = useParams<{ token: string }>();
  const user = useSelector(selectUser);
  const queryClient = useQueryClient();
  const acceptJoin = useAcceptJoinLink();
  const switchWorkspace = useSwitchWorkspace();
  const [failure, setFailure] = useState<JoinFailure | null>(null);

  const join = () => {
    setFailure(null);
    acceptJoin.mutate(token, {
      onSuccess: ({ workspaceId }) => {
        const joined = queryClient
          .getQueryData<ListWorkspacesResponseData>(queryKeys.workspaces)
          ?.find((entry) => entry.workspace.id === workspaceId);
        if (joined !== undefined) {
          toast.success(t('invites.joined', { workspace: joined.workspace.name }));
        }
        switchWorkspace(workspaceId);
      },
      onError: (err) => {
        setFailure(joinFailureFor(apiErrorStatus(err), apiErrorCode(err)));
      },
    });
  };

  return (
    <div className="mx-auto flex w-full max-w-[440px] flex-col gap-6">
      <PageMetadata title={pageTitle(t('invites.join.title'))} noIndex />
      <div className="flex flex-col gap-5 rounded-lg border bg-card p-6 sm:p-8">
        {failure === null ? (
          <>
            <div className="flex size-11 items-center justify-center rounded-full bg-sunken text-muted-foreground">
              <Link2 className="size-5" aria-hidden="true" />
            </div>
            <div className="flex flex-col gap-2">
              <h1 className="text-xl leading-tight font-semibold">{t('invites.join.title')}</h1>
              <p className="text-sm text-muted-foreground">{t('invites.join.lead')}</p>
              <p className="text-sm text-muted-foreground">
                {t('invites.join.signedInAs', { email: user?.email ?? '' })}
              </p>
            </div>
            <Button className="h-10 self-start px-5" onClick={join} disabled={acceptJoin.isPending}>
              {acceptJoin.isPending ? t('invites.accepting') : t('invites.join.accept')}
            </Button>
          </>
        ) : (
          <div role="alert" className="flex flex-col gap-4">
            <CircleAlert className="size-6 text-status-critical" aria-hidden="true" />
            <div className="flex flex-col gap-2">
              <h1 className="text-xl leading-tight font-semibold">
                {t(`invites.join.errors.${failure}Title`)}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t(`invites.join.errors.${failure}Body`, limits)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {failure === 'unknown' ? (
                <Button className="h-10 px-5" onClick={join} disabled={acceptJoin.isPending}>
                  {t('invites.tryAgain')}
                </Button>
              ) : null}
              <Link
                to={pathTo(ROUTES.DASHBOARD, language)}
                className={buttonVariants({ variant: 'outline' })}
              >
                {t('invites.goToDashboard')}
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
