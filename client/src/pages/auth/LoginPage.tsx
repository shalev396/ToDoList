import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { pageTitle } from '@/data/pageTitles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AuthHeading, FormError, FormField, authActionLinkClass } from '@/components/auth/auth-ui';
import { pathTo, ROUTES } from '@/router/routes';
import { safeNextPath } from '@/router/next';
import { useLanguage } from '@/hooks/useLanguage';
import { setAuthData } from '@/store/userSlice';
import { workspaceSelected } from '@/store/workspaceSlice';
import type { AppDispatch } from '@/store';
import { login, resendConfirmationCode } from '@/api/services/authService';
import { apiErrorCode, errorMessage } from '@/api/errors';

export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();
  const { language } = useLanguage();
  const [searchParams] = useSearchParams();
  const next = safeNextPath(searchParams.get('next'));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** HTTP 403 on POST login = unverified email (see server auth controller). */
  const [showVerifyEmailLink, setShowVerifyEmailLink] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isVerifyLoading, setIsVerifyLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setShowVerifyEmailLink(false);
    setIsLoading(true);

    try {
      const response = await login({ email, password }, { suppressErrorToast: true });
      const { tokens, hasWorkspaces, defaultWorkspaceId } = response.data;
      // GuestRoute takes the now signed-in user on: to `next`, else the dashboard, or onboarding
      // when there is no workspace (the selection below is null then). Navigating here as
      // well would race its redirect.
      dispatch(workspaceSelected(hasWorkspaces ? defaultWorkspaceId : null));
      dispatch(setAuthData({ idToken: tokens.idToken, refreshToken: tokens.refreshToken }));
    } catch (err) {
      setError(errorMessage(t, err, 'auth.login.error'));
      setShowVerifyEmailLink(apiErrorCode(err) === 'email_unverified');
      setIsLoading(false);
    }
  };

  const handleVerify = async () => {
    const trimmedEmail = email.trim();
    if (trimmedEmail === '' || isVerifyLoading) {
      return;
    }
    setIsVerifyLoading(true);
    try {
      await resendConfirmationCode({ email: trimmedEmail }, { suppressErrorToast: true });
      void navigate(pathTo(ROUTES.AUTH.CONFIRM_SIGNUP, language), {
        state: { email: trimmedEmail, next },
      });
    } catch {
      setError(t('auth.login.error'));
    } finally {
      setIsVerifyLoading(false);
    }
  };

  const signUpTarget = `${pathTo(ROUTES.AUTH.SIGNUP, language)}${
    next === null ? '' : `?next=${encodeURIComponent(next)}`
  }`;

  return (
    <>
      <PageMetadata title={pageTitle(t('auth.login.submit'))} noIndex />
      <div className="flex flex-col gap-6">
        <AuthHeading title={t('auth.login.title')} description={t('auth.login.description')} />

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-5">
          {error === null ? null : (
            <FormError>
              <p>{error}</p>
              {showVerifyEmailLink && email.trim() !== '' ? (
                <Button
                  type="button"
                  variant="link"
                  onClick={() => void handleVerify()}
                  disabled={isVerifyLoading}
                  className="mt-1 h-auto p-0 font-medium"
                >
                  {isVerifyLoading ? t('auth.login.verifySending') : t('auth.login.verifyEmailCta')}
                </Button>
              ) : null}
            </FormError>
          )}

          <FormField label={t('auth.login.email')} htmlFor="email">
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder={t('auth.login.emailPlaceholder')}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
              required
              disabled={isLoading}
            />
          </FormField>

          <FormField
            label={t('auth.login.password')}
            htmlFor="password"
            aside={
              <Link
                to={pathTo(ROUTES.AUTH.FORGOT_PASSWORD, language)}
                className="inline-flex min-h-11 items-center text-[13px] text-muted-foreground underline-offset-4 pointer-fine:min-h-0 hover:text-foreground hover:underline focus-visible:rounded-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {t('auth.login.forgotPassword')}
              </Link>
            }
          >
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
              required
              disabled={isLoading}
            />
          </FormField>

          <Button type="submit" className="h-10 w-full" disabled={isLoading}>
            {isLoading ? t('auth.login.loading') : t('auth.login.submit')}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          {t('auth.login.noAccount')}{' '}
          <Link to={signUpTarget} className={authActionLinkClass}>
            {t('auth.login.signUp')}
          </Link>
        </p>
      </div>
    </>
  );
}
