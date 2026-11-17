import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AuthHeading, FormError, FormField, authActionLinkClass } from '@/components/auth/auth-ui';
import { pathTo, ROUTES } from '@/router/routes';
import { useLanguage } from '@/hooks/useLanguage';
import { forgotPassword } from '@/api/services/authService';
import { errorMessage } from '@/api/errors';

export function ForgotPasswordForm() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      await forgotPassword({ email }, { suppressErrorToast: true });
      void navigate(
        `${pathTo(ROUTES.AUTH.RESET_PASSWORD, language)}?email=${encodeURIComponent(email)}`,
      );
    } catch (err) {
      setError(errorMessage(t, err, 'auth.forgotPassword.error'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <AuthHeading
        title={t('auth.forgotPassword.title')}
        description={t('auth.forgotPassword.description')}
      />
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-5">
        {error === null ? null : <FormError>{error}</FormError>}
        <FormField label={t('auth.forgotPassword.email')} htmlFor="email">
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder={t('auth.forgotPassword.emailPlaceholder')}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            required
            disabled={isLoading}
          />
        </FormField>
        <Button type="submit" className="h-10 w-full" disabled={isLoading}>
          {isLoading ? t('auth.forgotPassword.sending') : t('auth.forgotPassword.submit')}
        </Button>
      </form>
      <p className="text-center text-sm text-muted-foreground">
        {t('auth.forgotPassword.rememberPassword')}{' '}
        <Link to={pathTo(ROUTES.AUTH.LOGIN, language)} className={authActionLinkClass}>
          {t('auth.forgotPassword.signIn')}
        </Link>
      </p>
    </div>
  );
}
