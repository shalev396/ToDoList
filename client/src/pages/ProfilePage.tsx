import { useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Download, Mail, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
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
import { PageMetadata } from '@/components/shared/PageMetadata';
import { dateLocale, longDate } from '@/components/items/format';
import { pageTitle } from '@/data/pageTitles';
import { selectUser, logout } from '@/store/userSlice';
import { useMe, useSendTestEmail, useExportMyData, useDeleteAccount } from '@/api/queries';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import { PageContainer, PageHeader } from '@/features/shell/PageHeader';
import { UserAvatar } from '@/features/shell/UserAvatar';
import { SettingsSection } from '@/pages/settings/SettingsLayout';

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd
        className={mono ? 'text-sm break-all tabular-nums' : 'text-sm'}
        dir={mono ? 'ltr' : undefined}
      >
        {value}
      </dd>
    </div>
  );
}

/** My account: who I am to my workspaces, the account's details, my data. */
export default function ProfilePage() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const user = useSelector(selectUser);
  const { data: meData } = useMe();
  const { language } = useLanguage();
  const sendTestEmailMutation = useSendTestEmail();
  const exportMyDataMutation = useExportMyData();
  const deleteAccountMutation = useDeleteAccount();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const displayName = meData?.name ?? user?.name ?? '';
  const displayEmail = meData?.email ?? user?.email ?? '';
  const locale = dateLocale(language);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = (value: Date | string | null | undefined) =>
    value ? longDate(new Date(value), locale, timeZone) : t('profile.info.notSet');

  const handleSendTestEmail = () => {
    sendTestEmailMutation.mutate(undefined, {
      onSuccess: () => {
        toast.success(t('profile.testEmail.success'));
      },
      onError: () => {
        toast.error(t('profile.testEmail.error'));
      },
    });
  };

  const handleExportData = () => {
    exportMyDataMutation.mutate(undefined, {
      onSuccess: () => {
        toast.success(t('profile.exportData.success'));
      },
      onError: () => {
        toast.error(t('profile.exportData.error'));
      },
    });
  };

  const handleDeleteAccount = () => {
    deleteAccountMutation.mutate(undefined, {
      onSuccess: () => {
        setDeleteDialogOpen(false);
        // ProtectedRoute sends a signed-out user home.
        dispatch(logout({ signedOut: true }));
      },
      onError: () => {
        toast.error(t('profile.deleteAccount.error'));
      },
    });
  };

  return (
    <PageContainer width="reading">
      <PageMetadata title={pageTitle(t('profile.title'))} noIndex />
      <PageHeader title={t('profile.title')} description={t('profile.subtitle')} />

      <SettingsSection
        id="profile-account"
        title={t('profile.avatar.title')}
        hint={t('profile.avatar.description')}
      >
        <div className="flex items-center gap-4">
          <UserAvatar
            name={displayName || displayEmail}
            photoUrl={meData?.photoUrl}
            className="size-14 text-base"
          />
          <div className="flex min-w-0 flex-col">
            <p className="truncate text-base font-semibold">
              {displayName || t('profile.info.notSet')}
            </p>
            <p className="truncate text-sm text-muted-foreground" dir="ltr">
              {displayEmail}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to={pathTo(ROUTES.EDIT_PROFILE, language)}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <Pencil aria-hidden="true" />
            {t('profile.editButton')}
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSendTestEmail}
            disabled={sendTestEmailMutation.isPending}
          >
            <Mail aria-hidden="true" />
            {sendTestEmailMutation.isPending
              ? t('profile.testEmail.sending')
              : t('profile.testEmail.button')}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection id="profile-details" title={t('profile.info.title')}>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Detail label={t('profile.info.memberSince')} value={when(meData?.createdAt)} />
          <Detail label={t('profile.info.lastLogin')} value={when(meData?.lastLoginAt)} />
          <Detail label={t('profile.info.userId')} value={meData?.id ?? '…'} mono />
          <Detail
            label={t('profile.info.cognitoSub')}
            value={meData?.cognitoSub ?? user?.id ?? '…'}
            mono
          />
        </dl>
      </SettingsSection>

      <SettingsSection
        id="profile-data"
        title={t('profile.actions.title')}
        hint={t('profile.actions.description')}
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={handleExportData}
            disabled={exportMyDataMutation.isPending}
          >
            <Download aria-hidden="true" />
            {exportMyDataMutation.isPending
              ? t('profile.exportData.exporting')
              : t('profile.exportData.button')}
          </Button>
          <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="text-destructive hover:text-destructive">
                <Trash2 aria-hidden="true" />
                {t('profile.deleteAccount.button')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('profile.deleteAccount.dialogTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('profile.deleteAccount.dialogDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleteAccountMutation.isPending}>
                  {t('profile.deleteAccount.cancel')}
                </AlertDialogCancel>
                {/* A plain Button, not AlertDialogAction: the action closes the dialog on
                    click, hiding the pending state and any error. onSuccess closes it. */}
                <Button
                  variant="destructive"
                  onClick={handleDeleteAccount}
                  disabled={deleteAccountMutation.isPending}
                >
                  {deleteAccountMutation.isPending
                    ? t('profile.deleteAccount.deleting')
                    : t('profile.deleteAccount.confirm')}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </SettingsSection>
    </PageContainer>
  );
}
