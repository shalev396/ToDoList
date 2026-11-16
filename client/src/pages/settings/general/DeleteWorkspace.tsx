import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { FormError } from '@/components/auth/auth-ui';
import { useDeleteWorkspace, useDropWorkspace } from '@/api/queries';
import { errorMessage } from '@/api/errors';
import { SettingsSection } from '@/pages/settings/SettingsLayout';
import type { WorkspaceView } from '@api-types/api-contracts';

/**
 * Deleting the workspace: the dialog asks for its exact name. Afterwards the workspace
 * leaves my list and the reconciler moves me on (my oldest workspace, or onboarding).
 */
export function DeleteWorkspace({ workspace }: { workspace: WorkspaceView }) {
  const { t } = useTranslation();
  const deleteWorkspace = useDeleteWorkspace(workspace.id);
  const dropWorkspace = useDropWorkspace();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const inputId = useId();

  const confirm = () => {
    setFailed(null);
    deleteWorkspace.mutate(undefined, {
      onSuccess: () => {
        setOpen(false);
        toast.success(t('settings.danger.deleted', { workspace: workspace.name }));
        dropWorkspace(workspace.id);
      },
      onError: (err) => {
        setFailed(errorMessage(t, err, 'settings.danger.failed'));
      },
    });
  };

  return (
    <SettingsSection
      id="settings-danger"
      title={t('settings.danger.title')}
      hint={t('settings.danger.body', { workspace: workspace.name })}
    >
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setTyped('');
            setFailed(null);
          }
        }}
      >
        <AlertDialogTrigger asChild>
          <Button variant="outline" className="self-start text-destructive hover:text-destructive">
            {t('settings.danger.button')}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.danger.dialogTitle', { workspace: workspace.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('settings.danger.dialogBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={inputId} className="text-sm font-medium">
              {t('settings.danger.confirmLabel')}
            </label>
            <Input
              id={inputId}
              value={typed}
              autoComplete="off"
              placeholder={workspace.name}
              onChange={(e) => {
                setTyped(e.target.value);
              }}
            />
          </div>
          {failed === null ? null : <FormError>{failed}</FormError>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteWorkspace.isPending}>
              {t('settings.danger.cancel')}
            </AlertDialogCancel>
            {/* A plain Button: AlertDialogAction would close before the request finishes. */}
            <Button
              variant="destructive"
              onClick={confirm}
              disabled={typed.trim() !== workspace.name || deleteWorkspace.isPending}
            >
              {deleteWorkspace.isPending
                ? t('settings.danger.deleting')
                : t('settings.danger.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
