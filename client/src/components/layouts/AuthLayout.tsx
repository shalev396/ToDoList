import { Link, Outlet } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { assets } from '@/data';
import { LanguageSwitcher } from '@/components/ui/language-switcher';
import { ModeToggle } from '@/components/ui/mode-toggle';
import { authLinkClass } from '@/components/auth/auth-ui';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';

/**
 * Login, sign-up, confirm, forgot and reset: one narrow card on the page plane, the ring mark
 * above it (a link home), and nothing else competing with the form.
 */
export function AuthLayout() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { LogoMark } = assets;

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex min-h-[calc(3.5rem+var(--safe-top))] items-center justify-end gap-1 px-3 pt-[var(--safe-top)] sm:px-5">
        <LanguageSwitcher />
        <ModeToggle />
      </header>
      <main className="flex flex-1 flex-col items-center px-4 pt-2 pb-12 sm:pt-10">
        <Link
          to={pathTo(ROUTES.HOME, language)}
          aria-label={t('auth.layout.home')}
          className="mb-6 flex min-h-11 min-w-11 items-center justify-center rounded-md pointer-fine:min-h-0 pointer-fine:min-w-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background focus-visible:outline-none"
        >
          <LogoMark className="size-10" />
        </Link>
        <div className="w-full max-w-[400px] rounded-lg border bg-card p-6 sm:p-8">
          <Outlet />
        </div>
        <p className="mt-6 max-w-[400px] text-center text-xs text-pretty text-muted-foreground">
          <Trans
            i18nKey="auth.layout.agreeTo"
            components={{
              termsLink: (
                <Link to={pathTo(ROUTES.LEGAL.TERMS, language)} className={authLinkClass} />
              ),
              privacyLink: (
                <Link to={pathTo(ROUTES.LEGAL.PRIVACY, language)} className={authLinkClass} />
              ),
            }}
          />
        </p>
      </main>
    </div>
  );
}
