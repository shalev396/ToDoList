import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AuthHeading, FormError, FormField, authActionLinkClass } from '@/components/auth/auth-ui';
import { pathTo, ROUTES } from '@/router/routes';
import { safeNextPath } from '@/router/next';
import { useLanguage } from '@/hooks/useLanguage';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { pageTitle } from '@/data/pageTitles';
import { confirmSignup } from '@/api/services/authService';
import { errorMessage } from '@/api/errors';

interface ConfirmState {
  email?: string;
  /** The page to return to after logging in (an invite link, say). */
  next?: string | null;
}

export default function ConfirmSignUpPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { language } = useLanguage();
  const location = useLocation();

  const state = location.state as ConfirmState | null;
  const emailFromState = state?.email ?? '';
  const next = safeNextPath(state?.next ?? null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(false);

  if (!emailFromState) {
    return <Navigate to={pathTo(ROUTES.AUTH.LOGIN, language)} replace />;
  }

  const loginTarget = `${pathTo(ROUTES.AUTH.LOGIN, language)}${
    next === null ? '' : `?next=${encodeURIComponent(next)}`
  }`;

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      await confirmSignup({ email: emailFromState, code }, { suppressErrorToast: true });
      setIsConfirmed(true);
      setTimeout(() => {
        void navigate(loginTarget);
      }, 2000);
    } catch (err) {
      setError(errorMessage(t, err, 'auth.confirm.error'));
    } finally {
      setIsLoading(false);
    }
  };

  if (isConfirmed) {
    return (
      <>
        <PageMetadata title={pageTitle(t('auth.confirm.title'))} noIndex />
        <div className="flex flex-col gap-4" role="status">
          <CircleCheck className="size-6 text-status-good" aria-hidden="true" />
          <AuthHeading
            title={t('auth.confirm.confirmed')}
            description={t('auth.confirm.redirectingToLogin')}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageMetadata title={pageTitle(t('auth.confirm.title'))} noIndex />
      <div className="flex flex-col gap-6">
        <AuthHeading
          title={t('auth.confirm.title')}
          description={
            <Trans
              i18nKey="auth.confirm.codeSentTo"
              values={{ email: emailFromState }}
              components={{ strong: <strong className="font-medium text-foreground" /> }}
            />
          }
        />

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-5">
          {error === null ? null : <FormError>{error}</FormError>}

          <FormField label={t('auth.confirm.codeLabel')} htmlFor="code">
            <Input
              id="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              className="tabular-nums tracking-[0.2em]"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
              }}
              required
              disabled={isLoading}
            />
          </FormField>

          <Button type="submit" className="h-10 w-full" disabled={isLoading}>
            {isLoading ? t('auth.confirm.verifying') : t('auth.confirm.verify')}
          </Button>
        </form>

        <p className="text-center text-sm">
          <Link to={loginTarget} className={authActionLinkClass}>
            {t('auth.confirm.goToLogin')}
          </Link>
        </p>
      </div>
    </>
  );
}
