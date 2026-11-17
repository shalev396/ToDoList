import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AuthHeading, FormError, FormField } from '@/components/auth/auth-ui';
import { pathTo, ROUTES } from '@/router/routes';
import { useLanguage } from '@/hooks/useLanguage';
import { resetPassword } from '@/api/services/authService';
import { errorMessage } from '@/api/errors';

export function ResetPasswordForm() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [searchParams] = useSearchParams();

  const [email, setEmail] = useState(searchParams.get('email') ?? '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t('auth.resetPassword.passwordMismatch'));
      return;
    }

    setIsLoading(true);
    try {
      await resetPassword({ email, code, password }, { suppressErrorToast: true });
      void navigate(pathTo(ROUTES.AUTH.LOGIN, language));
    } catch (err) {
      setError(errorMessage(t, err, 'auth.resetPassword.error'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <AuthHeading
        title={t('auth.resetPassword.title')}
        description={t('auth.resetPassword.description')}
      />
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-5">
        {error === null ? null : <FormError>{error}</FormError>}
        <FormField label={t('auth.forgotPassword.email')} htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            required
            disabled={isLoading}
          />
        </FormField>
        <FormField label={t('auth.resetPassword.code')} htmlFor="code">
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
        <FormField
          label={t('auth.resetPassword.newPassword')}
          htmlFor="password"
          hint={t('auth.resetPassword.passwordHint')}
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
        <FormField label={t('auth.resetPassword.confirmPassword')} htmlFor="confirm-password">
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
          {isLoading ? t('auth.resetPassword.resetting') : t('auth.resetPassword.submit')}
        </Button>
      </form>
    </div>
  );
}
