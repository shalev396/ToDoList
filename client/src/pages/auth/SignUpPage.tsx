import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { pageTitle } from '@/data/pageTitles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AuthHeading, FormError, FormField, authActionLinkClass } from '@/components/auth/auth-ui';
import { pathTo, ROUTES } from '@/router/routes';
import { safeNextPath } from '@/router/next';
import { useLanguage } from '@/hooks/useLanguage';
import { signup } from '@/api/services/authService';
import { errorMessage } from '@/api/errors';

export default function SignUpPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { language } = useLanguage();
  const [searchParams] = useSearchParams();
  const next = safeNextPath(searchParams.get('next'));

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t('auth.signUp.passwordMismatch'));
      return;
    }

    setIsLoading(true);
    try {
      await signup({ name, email, password }, { suppressErrorToast: true });
      void navigate(pathTo(ROUTES.AUTH.CONFIRM_SIGNUP, language), { state: { email, next } });
    } catch (err) {
      setError(errorMessage(t, err, 'auth.signUp.error'));
    } finally {
      setIsLoading(false);
    }
  };

  const loginTarget = `${pathTo(ROUTES.AUTH.LOGIN, language)}${
    next === null ? '' : `?next=${encodeURIComponent(next)}`
  }`;

  return (
    <>
      <PageMetadata title={pageTitle(t('auth.signUp.title'))} noIndex />
      <div className="flex flex-col gap-6">
        <AuthHeading title={t('auth.signUp.title')} description={t('auth.signUp.description')} />

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-5">
          {error === null ? null : <FormError>{error}</FormError>}

          <FormField label={t('auth.signUp.fullName')} htmlFor="name">
            <Input
              id="name"
              type="text"
              autoComplete="name"
              placeholder={t('auth.signUp.namePlaceholder')}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              required
              disabled={isLoading}
            />
          </FormField>
          <FormField label={t('auth.signUp.email')} htmlFor="email">
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder={t('auth.signUp.emailPlaceholder')}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
              required
              disabled={isLoading}
            />
          </FormField>
          <FormField
            label={t('auth.signUp.password')}
            htmlFor="password"
            hint={t('auth.signUp.passwordHint')}
          >
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              aria-describedby="password-hint"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
              required
              minLength={8}
              disabled={isLoading}
            />
          </FormField>
          <FormField label={t('auth.signUp.confirmPassword')} htmlFor="confirm-password">
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
              }}
              required
              minLength={8}
              disabled={isLoading}
            />
          </FormField>

          <Button type="submit" className="h-10 w-full" disabled={isLoading}>
            {isLoading ? t('auth.signUp.loading') : t('auth.signUp.submit')}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          {t('auth.signUp.haveAccount')}{' '}
          <Link to={loginTarget} className={authActionLinkClass}>
            {t('auth.signUp.signIn')}
          </Link>
        </p>
      </div>
    </>
  );
}
