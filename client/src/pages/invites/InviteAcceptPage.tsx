import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useDispatch, useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CircleAlert, MailOpen } from 'lucide-react';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { pageTitle } from '@/data/pageTitles';
import { limits } from '@/data/limits';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { useAcceptInvite } from '@/api/queries/invites';
import { queryKeys } from '@/api/queries/keys';
import { apiErrorCode, apiErrorStatus } from '@/api/errors';
import { useLanguage } from '@/hooks/useLanguage';
import { invitePath, pathTo, ROUTES } from '@/router/routes';
import { selectUser } from '@/store/userSlice';
import { inviteFailureFor, type InviteFailure } from '@/features/invites/invites';
import { useSwitchWorkspace } from '@/features/workspaces/useSwitchWorkspace';
import { loginPathWithNext } from '@/router/next';
import { logout } from '@/store/userSlice';
import type { ListWorkspacesResponseData } from '@api-types/api-contracts';

const FAILURE_COPY: Record<InviteFailure, { title: string; body: string }> = {
  wrongEmail: {
    title: 'invites.errors.wrongEmailTitle',
    body: 'invites.errors.wrongEmailBody',
  },
  expired: { title: 'invites.errors.expiredTitle', body: 'invites.errors.expiredBody' },
  used: { title: 'invites.errors.usedTitle', body: 'invites.errors.usedBody' },
  alreadyMember: {
    title: 'invites.errors.alreadyMemberTitle',
    body: 'invites.errors.alreadyMemberBody',
  },
  workspaceFull: {
    title: 'invites.errors.workspaceFullTitle',
    body: 'invites.errors.workspaceFullBody',
  },
  unknown: { title: 'invites.errors.unknownTitle', body: 'invites.errors.unknownBody' },
};

/**
 * An invite link (`invites/:token`). Signed-out visitors log in first and come back (ProtectedRoute
 * `next`). Accepting joins the workspace, makes it current and opens its dashboard. The
 * token stays in this page's URL only; it is never stored or logged.
 */
export default function InviteAcceptPage() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { token = '' } = useParams<{ token: string }>();
  const user = useSelector(selectUser);
  const queryClient = useQueryClient();
  const acceptInvite = useAcceptInvite();
  const switchWorkspace = useSwitchWorkspace();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const [failure, setFailure] = useState<InviteFailure | null>(null);
  const email = user?.email ?? '';

  const accept = () => {
    setFailure(null);
    acceptInvite.mutate(token, {
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
        setFailure(inviteFailureFor(apiErrorStatus(err), apiErrorCode(err)));
      },
    });
  };

  const copy = failure === null ? null : FAILURE_COPY[failure];

  /** Sign out, then log in as the invited address and come straight back to this link. */
  const signInWithAnotherAccount = () => {
    dispatch(logout());
    void navigate(loginPathWithNext(language, pathTo(invitePath(token), language)), {
      replace: true,
    });
  };

  return (
    <div className="mx-auto flex w-full max-w-[440px] flex-col gap-6">
      <PageMetadata title={pageTitle(t('invites.title'))} noIndex />
      <div className="flex flex-col gap-5 rounded-lg border bg-card p-6 sm:p-8">
        {copy === null ? (
          <>
            <div className="flex size-11 items-center justify-center rounded-full bg-sunken text-muted-foreground">
              <MailOpen className="size-5" aria-hidden="true" />
            </div>
            <div className="flex flex-col gap-2">
              <h1 className="text-xl leading-tight font-semibold">{t('invites.title')}</h1>
              <p className="text-sm text-muted-foreground">{t('invites.lead')}</p>
              <p className="text-sm text-muted-foreground">{t('invites.signedInAs', { email })}</p>
            </div>
            <Button
              className="h-10 self-start px-5"
              onClick={accept}
              disabled={acceptInvite.isPending}
            >
              {acceptInvite.isPending ? t('invites.accepting') : t('invites.accept')}
            </Button>
          </>
        ) : (
          <div role="alert" className="flex flex-col gap-4">
            <CircleAlert className="size-6 text-status-critical" aria-hidden="true" />
            <div className="flex flex-col gap-2">
              <h1 className="text-xl leading-tight font-semibold">{t(copy.title)}</h1>
              <p className="text-sm text-muted-foreground">{t(copy.body, { email, ...limits })}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {failure === 'wrongEmail' ? (
                <Button className="h-10 px-5" onClick={signInWithAnotherAccount}>
                  {t('invites.useAnotherAccount')}
                </Button>
              ) : null}
              {failure === 'unknown' ? (
                <Button className="h-10 px-5" onClick={accept} disabled={acceptInvite.isPending}>
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
