import { useTranslation } from 'react-i18next';
import { ResetPasswordForm } from '@/components/forms/ResetPasswordForm';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { pageTitle } from '@/data/pageTitles';

export default function ResetPasswordPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageMetadata title={pageTitle(t('auth.resetPassword.title'))} noIndex />
      <ResetPasswordForm />
    </>
  );
}
