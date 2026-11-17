import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { UserMinus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useRemoveMember } from '@/api/queries';
import { errorMessage } from '@/api/errors';
import type { MemberView, WorkspaceView } from '@api-types/api-contracts';

/** Removing a member, after a confirmation. */
export function RemoveMember({
  workspace,
  member,
  name,
}: {
  workspace: WorkspaceView;
  member: MemberView;
  name: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Before the refetch takes this row (and this dialog) away: close, then say so.
  const removeMember = useRemoveMember(workspace.id, () => {
    setOpen(false);
    toast.success(t('members.list.removed', { name }));
  });
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('members.list.remove', { name })}
          className="text-muted-foreground hover:text-destructive"
        >
          <UserMinus aria-hidden="true" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('members.list.removeTitle', { name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('members.list.removeBody', { workspace: workspace.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removeMember.isPending}>
            {t('members.list.cancel')}
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={removeMember.isPending}
            onClick={() => {
              removeMember.mutate(member.userId, {
                onError: (err) => {
                  toast.error(errorMessage(t, err, 'members.list.removeFailed'));
                },
              });
            }}
          >
            {t('members.list.removeConfirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
