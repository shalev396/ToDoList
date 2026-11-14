import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLanguage } from '@/hooks/useLanguage';
import { invitePath, joinPath, pathTo } from '@/router/routes';
import { parseInviteToken } from '@/features/invites/invites';
import { parseJoinToken } from '@/features/sharing/shareState';

/** "Join with an invite link": paste the emailed link, land on its accept page. */
export function JoinInviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { language } = useLanguage();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setValue('');
      setInvalid(false);
    }
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const joinToken = parseJoinToken(value);
    const token = joinToken ?? parseInviteToken(value);
    if (token === null) {
      setInvalid(true);
      return;
    }
    close(false);
    void navigate(pathTo(joinToken === null ? invitePath(token) : joinPath(token), language));
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent closeLabel={t('app.page.close')}>
        <DialogHeader>
          <DialogTitle>{t('app.join.title')}</DialogTitle>
          <DialogDescription>{t('app.join.description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="invite-link" className="text-sm font-medium">
              {t('app.join.label')}
            </label>
            <Input
              id="invite-link"
              value={value}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              aria-invalid={invalid}
              aria-describedby={invalid ? 'invite-link-error' : undefined}
              onChange={(event) => {
                setValue(event.target.value);
                setInvalid(false);
              }}
            />
            {invalid ? (
              <p id="invite-link-error" className="text-[13px] text-destructive">
                {t('app.join.invalid')}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={value.trim() === ''}>
              {t('app.join.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
