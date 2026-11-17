import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
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
import { useDropWorkspace, useLeaveWorkspace } from '@/api/queries';
import { errorMessage } from '@/api/errors';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import type { WorkspaceView } from '@api-types/api-contracts';

/**
 * Leaving (everyone but the owner). Afterwards the workspace leaves my list and the reconciler
 * moves me on: my oldest workspace's dashboard, or onboarding.
 */
export function LeaveWorkspace({ workspace }: { workspace: WorkspaceView }) {
  const { t } = useTranslation();
  const leaveWorkspace = useLeaveWorkspace(workspace.id);
  const dropWorkspace = useDropWorkspace();
  const [open, setOpen] = useState(false);
  const titleId = useId();

  const leave = () => {
    leaveWorkspace.mutate(undefined, {
      onSuccess: () => {
        setOpen(false);
        toast.success(t('members.leave.left', { workspace: workspace.name }));
        dropWorkspace(workspace.id);
      },
      onError: (err) => {
        toast.error(errorMessage(t, err, 'members.leave.failed'));
      },
    });
  };

  return (
    <SettingsSection
      id={titleId}
      title={t('members.leave.title')}
      hint={t('members.leave.body', { workspace: workspace.name })}
    >
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger asChild>
          <Button variant="outline" className="self-start text-destructive hover:text-destructive">
            {t('members.leave.button')}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('members.leave.dialogTitle', { workspace: workspace.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('members.leave.body', { workspace: workspace.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={leaveWorkspace.isPending}>
              {t('members.leave.cancel')}
            </AlertDialogCancel>
            <Button variant="destructive" onClick={leave} disabled={leaveWorkspace.isPending}>
              {leaveWorkspace.isPending ? t('members.leave.leaving') : t('members.leave.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
