import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { browserTimeZone, dateLocale, shortDate } from '@/components/items/format';
import { useInvites, useRevokeInvite } from '@/api/queries';
import { errorMessage } from '@/api/errors';
import { useLanguage } from '@/hooks/useLanguage';
import { useNow } from '@/hooks/useNow';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import type { WorkspaceView } from '@api-types/api-contracts';

/** Invites not yet accepted (owners only), each with Revoke. */
export function PendingInvites({ workspace }: { workspace: WorkspaceView }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { data: invites } = useInvites(workspace.id, true);
  const revokeInvite = useRevokeInvite(workspace.id);
  const titleId = useId();
  const locale = dateLocale(language);
  const timeZone = browserTimeZone();
  const now = useNow();
  const pending = (invites ?? []).filter(
    (invite) => invite.status === 'pending' && new Date(invite.expiresAt).getTime() > now.getTime(),
  );

  return (
    <SettingsSection id={titleId} title={t('members.pending.title')} layout="stacked">
      {pending.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('members.pending.empty')}</p>
      ) : (
        <ul className="@container flex flex-col divide-y rounded-lg border bg-card">
          {pending.map((invite) => (
            <li key={invite.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 @xl:flex-row @xl:items-center @xl:gap-4">
                <span className="min-w-0 truncate text-sm font-medium @xl:flex-1" dir="ltr">
                  {invite.email}
                </span>
                <span className="flex flex-wrap gap-x-4 text-[13px] text-muted-foreground">
                  <span>{t(`app.roles.${invite.role}`)}</span>
                  <span className="tabular-nums">
                    {t('members.pending.expires', {
                      date: shortDate(new Date(invite.expiresAt), locale, timeZone),
                    })}
                  </span>
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                aria-label={t('members.pending.revokeLabel', { email: invite.email })}
                disabled={revokeInvite.isPending}
                onClick={() => {
                  revokeInvite.mutate(invite.id, {
                    onSuccess: () => {
                      toast.success(t('members.pending.revoked'));
                    },
                    onError: (err) => {
                      toast.error(errorMessage(t, err, 'members.pending.revokeFailed'));
                    },
                  });
                }}
              >
                {t('members.pending.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
