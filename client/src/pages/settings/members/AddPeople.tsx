import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select';
import { FormError } from '@/components/auth/auth-ui';
import { useCreateInvite } from '@/api/queries';
import { errorMessage } from '@/api/errors';
import { useLanguage } from '@/hooks/useLanguage';
import {
  canSendInvites,
  INVITE_MESSAGE_MAX,
  parseEmails,
  summarizeSends,
  type SeatOutcome,
  type ShareRole,
} from '@/features/sharing/shareState';
import type { WorkspaceView } from '@api-types/api-contracts';

/**
 * The Share dialog's "Add people": several emails, one role and a short message, for the whole
 * workspace. Each address gets its own invite and its own email.
 */
export function AddPeople({ workspace }: { workspace: WorkspaceView }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const createInvite = useCreateInvite(workspace.id);
  const formId = useId();
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<ShareRole>('viewer');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { valid, invalid } = parseEmails(emails);
    if (invalid.length > 0) {
      setError(t('members.invite.invalidEmails', { emails: invalid.join(', ') }));
      return;
    }
    setError(null);
    setSending(true);
    const results: SeatOutcome[] = [];
    const failures: string[] = [];
    for (const email of valid) {
      try {
        const sent = await createInvite.mutateAsync({
          email,
          role,
          language: language === 'he' ? 'he' : 'en',
          ...(message.trim() === '' ? {} : { message: message.trim() }),
        });
        results.push({ email, ok: true, url: sent.inviteUrl });
      } catch (err) {
        results.push({ email, ok: false });
        failures.push(`${email}: ${errorMessage(t, err, 'members.invite.failed')}`);
      }
    }
    setSending(false);
    const { sent, failed } = summarizeSends(results);
    if (failures.length > 0) {
      setError(failures.join(' '));
    }
    if (sent > 0) {
      toast.success(t('members.invite.sent', { count: sent }));
    }
    if (failed === 0) {
      setEmails('');
      setMessage('');
    } else {
      // Keep only the addresses that failed, so a retry doesn't invite the others again.
      setEmails(
        results
          .filter((result) => !result.ok)
          .map((result) => result.email)
          .join(', '),
      );
    }
  };

  const busy = sending || createInvite.isPending;
  return (
    <section aria-labelledby={`${formId}-title`} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 id={`${formId}-title`} className="text-sm font-semibold">
          {t('members.invite.title')}
        </h3>
        <p className="text-[13px] text-muted-foreground">{t('members.invite.hint')}</p>
      </div>
      <form
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
        aria-labelledby={`${formId}-title`}
      >
        {error === null ? null : <FormError>{error}</FormError>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-email`} className="text-sm font-medium">
              {t('members.invite.email')}
            </label>
            <Input
              id={`${formId}-email`}
              type="text"
              inputMode="email"
              value={emails}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              className="text-start"
              placeholder={t('members.invite.emailPlaceholder')}
              onChange={(e) => {
                setEmails(e.target.value);
              }}
              disabled={busy}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-role`} className="text-sm font-medium">
              {t('members.invite.role')}
            </label>
            <SelectField
              id={`${formId}-role`}
              value={role}
              aria-describedby={`${formId}-role-hint`}
              onValueChange={(next) => {
                setRole(next === 'editor' ? 'editor' : 'viewer');
              }}
              disabled={busy}
              options={[
                { value: 'viewer', label: t('members.share.canView') },
                { value: 'editor', label: t('members.share.canEdit') },
              ]}
            />
          </div>
        </div>
        <p id={`${formId}-role-hint`} className="-mt-2 text-[13px] text-muted-foreground">
          {t(`members.roleHints.${role}`)}
        </p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${formId}-message`} className="text-sm font-medium">
            {t('members.invite.message')}
          </label>
          <textarea
            id={`${formId}-message`}
            value={message}
            rows={1}
            maxLength={INVITE_MESSAGE_MAX}
            placeholder={t('members.invite.messagePlaceholder')}
            disabled={busy}
            onChange={(e) => {
              setMessage(e.target.value);
            }}
            className="min-h-11 w-full resize-none pointer-fine:min-h-9 rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30"
          />
        </div>
        <Button type="submit" className="self-start" disabled={!canSendInvites(emails, busy)}>
          {busy ? t('members.invite.submitting') : t('members.invite.submit')}
        </Button>
      </form>
    </section>
  );
}
