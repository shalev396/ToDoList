import { Link, Outlet } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { LogOut } from 'lucide-react';
import { app, assets } from '@/data';
import { Button } from '@/components/ui/button';
import { LanguageSwitcher } from '@/components/ui/language-switcher';
import { ModeToggle } from '@/components/ui/mode-toggle';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import { selectUser } from '@/store/userSlice';
import { useSignOut } from '@/features/shell/useSignOut';
import { useWorkspaceReconciler } from '@/features/workspaces/useWorkspaceReconciler';

/**
 * Signed in, but outside the app shell: onboarding and invite links. The mark, who is signed in
 * with a way out, and one focused column; nothing else to wander into.
 */
export default function FocusLayout() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const user = useSelector(selectUser);
  const signOut = useSignOut();
  const { LogoIcon } = assets;
  useWorkspaceReconciler();

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex h-14 items-center gap-2 border-b px-3 pt-[env(safe-area-inset-top)] sm:px-5">
        <Link
          to={pathTo(ROUTES.HOME, language)}
          className="flex min-h-11 items-center gap-2 rounded-sm text-base font-semibold pointer-fine:min-h-9 tracking-[-0.01em] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <LogoIcon className="size-6" />
          {app.name}
        </Link>
        <div className="ms-auto flex items-center gap-1">
          {user ? (
            <span className="hidden max-w-[24ch] truncate px-2 text-[13px] text-muted-foreground sm:inline">
              {t('onboarding.signedInAs', { email: user.email })}
            </span>
          ) : null}
          <LanguageSwitcher />
          <ModeToggle />
          <Button
            type="button"
            variant="ghost"
            onClick={signOut}
            className="min-h-11 min-w-11 px-3 text-muted-foreground pointer-fine:min-h-9 pointer-fine:min-w-0"
          >
            <LogOut className="size-4 rtl:-scale-x-100" aria-hidden="true" />
            <span className="hidden sm:inline">{t('onboarding.signOut')}</span>
            <span className="sr-only sm:hidden">{t('onboarding.signOut')}</span>
          </Button>
        </div>
      </header>
      <main className="flex flex-1 flex-col px-4 pt-8 pb-16 sm:pt-14">
        <Outlet />
      </main>
    </div>
  );
}
