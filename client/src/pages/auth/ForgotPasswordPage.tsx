import { useTranslation } from 'react-i18next';
import { ForgotPasswordForm } from '@/components/forms/ForgotPasswordForm';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { pageTitle } from '@/data/pageTitles';

export default function ForgotPasswordPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageMetadata title={pageTitle(t('auth.forgotPassword.title'))} noIndex />
      <ForgotPasswordForm />
    </>
  );
}
