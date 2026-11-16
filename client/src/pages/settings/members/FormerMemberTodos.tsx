import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { errorMessage } from '@/api/errors';
import { useDeleteFormerMemberTodos, useFormerMemberTodos } from '@/api/queries/members';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

/**
 * Owners (PERMISSIONS-V2 ruling 6): the private to-dos of people who left stay, unreadable by
 * anyone. This offers to delete them, by count only: their content is never shown. Nothing
 * renders while there are none.
 */
export function FormerMemberTodos({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const count = useFormerMemberTodos(workspaceId, true);
  const remove = useDeleteFormerMemberTodos(workspaceId);
  const [confirming, setConfirming] = useState(false);
  const total = count.data ?? 0;
  if (total === 0) {
    return null;
  }
  const confirm = async () => {
    try {
      const deleted = await remove.mutateAsync();
      toast.success(t('members.former.done', { count: deleted }));
    } catch (failure) {
      toast.error(errorMessage(t, failure, 'members.former.failed'));
    }
  };
  return (
    <div data-former-member-todos className="flex">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="max-md:h-11"
        disabled={remove.isPending}
        onClick={() => {
          setConfirming(true);
        }}
      >
        {t('members.former.action', { count: total })}
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-former-member-todos-confirm>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('members.former.title', { count: total })}</AlertDialogTitle>
            <AlertDialogDescription>{t('members.former.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('members.former.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void confirm();
              }}
            >
              {t('members.former.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
