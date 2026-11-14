import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Copy, Globe, Lock, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { FormError } from '@/components/auth/auth-ui';
import { useJoinLink, useResetJoinLink, useSetJoinLink } from '@/api/queries';
import { errorMessage } from '@/api/errors';
import { useLanguage } from '@/hooks/useLanguage';
import {
  generalAccessOf,
  joinLinkFor,
  joinLinkRequest,
  linkRoleOf,
  type GeneralAccess as Access,
  type ShareRole,
} from '@/features/sharing/shareState';
import type { WorkspaceView } from '@api-types/api-contracts';

/**
 * "General access", like Drive: Restricted (only the people invited) or Anyone with the link, who
 * joins as a viewer or an editor (never an owner), with Copy link and Reset link. The link holds
 * a token: it is read from the server while this is open and kept nowhere else.
 */
export function GeneralAccess({ workspace }: { workspace: WorkspaceView }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const link = useJoinLink(workspace.id, true);
  const setLink = useSetJoinLink(workspace.id);
  const resetLink = useResetJoinLink(workspace.id);
  const inputRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const [error, setError] = useState<string | null>(null);
  const access = generalAccessOf(link.data);
  const role = linkRoleOf(link.data);
  const url = joinLinkFor(link.data, language, window.location.origin);
  const busy = setLink.isPending || resetLink.isPending;

  const change = (nextAccess: Access, nextRole: ShareRole) => {
    setError(null);
    setLink.mutate(joinLinkRequest(nextAccess, nextRole), {
      onError: (err) => {
        setError(errorMessage(t, err, 'members.access.failed'));
      },
    });
  };

  const copy = async () => {
    if (url === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('members.invite.copied'));
    } catch {
      inputRef.current?.select();
      toast.error(t('members.invite.copyFailed'));
    }
  };

  const Icon = access === 'link' ? Globe : Lock;
  return (
    <section aria-labelledby={`${formId}-title`} className="flex flex-col gap-4">
      <h3 id={`${formId}-title`} className="text-sm font-semibold">
        {t('members.access.title')}
      </h3>
      {error === null ? null : <FormError>{error}</FormError>}
      <div className="flex items-start gap-3">
        <Icon className="mt-2.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <SelectField
              aria-label={t('members.access.title')}
              value={access}
              disabled={busy || link.data === undefined}
              onValueChange={(next) => {
                change(next === 'link' ? 'link' : 'restricted', role);
              }}
              options={[
                { value: 'restricted', label: t('members.access.restricted') },
                { value: 'link', label: t('members.access.anyone') },
              ]}
            />
            {access === 'link' ? (
              <SelectField
                aria-label={t('members.access.linkRole')}
                value={role}
                disabled={busy}
                onValueChange={(next) => {
                  change('link', next === 'editor' ? 'editor' : 'viewer');
                }}
                options={[
                  { value: 'viewer', label: t('members.share.canView') },
                  { value: 'editor', label: t('members.share.canEdit') },
                ]}
              />
            ) : null}
          </div>
          <p className="text-[13px] text-muted-foreground">
            {access === 'link'
              ? t(`members.access.linkHint.${role}`)
              : t('members.access.restrictedHint')}
          </p>
        </div>
      </div>
      {access === 'link' && link.data !== undefined ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          {url === null ? (
            <p className="min-w-0 flex-1 self-center text-[13px] text-muted-foreground">
              {t('members.access.unreadable')}
            </p>
          ) : (
            <Input
              ref={inputRef}
              value={url}
              readOnly
              dir="ltr"
              aria-label={t('members.access.linkLabel')}
              className="min-w-0 flex-1 bg-sunken text-start text-[13px]"
              onFocus={(e) => {
                e.currentTarget.select();
              }}
            />
          )}
          <div className="flex gap-2">
            {url === null ? null : (
              <Button type="button" onClick={() => void copy()}>
                <Copy aria-hidden="true" />
                {t('members.access.copy')}
              </Button>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  <RotateCcw aria-hidden="true" />
                  {t('members.access.reset')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('members.access.resetTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('members.access.resetBody')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('members.list.cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      resetLink.mutate(undefined, {
                        onSuccess: () => {
                          toast.success(t('members.access.resetDone'));
                        },
                        onError: (err) => {
                          toast.error(errorMessage(t, err, 'members.access.failed'));
                        },
                      });
                    }}
                  >
                    {t('members.access.resetConfirm')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      ) : null}
    </section>
  );
}
