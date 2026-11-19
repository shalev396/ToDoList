import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Menu } from 'lucide-react';
import { assets } from '@/data';
import { cn } from '@/lib/utils';
import { ModeToggle } from '@/components/ui/mode-toggle';
import { LanguageSwitcher } from '@/components/ui/language-switcher';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { UserMenu } from '@/components/shared/UserMenu';
import { ctaVariants } from '@/components/shared/cta-variants';
import { useTheme } from '@/components/theme-context';
import { selectIsAuthenticated } from '@/store/userSlice';
import { pathTo, ROUTES } from '@/router/routes';
import { useLanguage } from '@/hooks/useLanguage';
import { LANGUAGE_NAMES } from '@/i18n/config';
import { ScrollArea } from '@/components/ui/scroll-area';

const navLink =
  'inline-flex h-9 items-center rounded-sm px-3 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

const segment =
  'flex h-9 flex-1 items-center justify-center rounded-sm text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-pressed:bg-card aria-pressed:font-medium aria-pressed:text-foreground text-muted-foreground hover:text-foreground';

function MobileMenu({ isAuthenticated }: { isAuthenticated: boolean }) {
  const { t } = useTranslation();
  const { language, changeLanguage, availableLanguages } = useLanguage();
  const { theme, setTheme } = useTheme();
  const home = pathTo(ROUTES.HOME, language);

  return (
    <Sheet>
      <SheetTrigger
        className="flex size-9 items-center justify-center rounded-sm text-foreground transition-colors hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:hidden"
        aria-label={t('nav.openMenu')}
      >
        <Menu className="size-5" aria-hidden="true" />
      </SheetTrigger>
      <SheetContent side="end" closeLabel={t('nav.closeMenu')} aria-describedby={undefined}>
        <SheetHeader className="h-14 justify-center border-b py-0">
          <SheetTitle className="text-sm">{t('nav.menu')}</SheetTitle>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-6 px-4 pb-6">
            <ul className="flex flex-col">
              <li>
                <SheetClose asChild>
                  <Link
                    to={{ pathname: home, hash: '#features' }}
                    className="flex h-11 items-center text-[15px]"
                  >
                    {t('nav.features')}
                  </Link>
                </SheetClose>
              </li>
              <li>
                <SheetClose asChild>
                  <Link
                    to={pathTo(ROUTES.PRICING, language)}
                    className="flex h-11 items-center text-[15px]"
                  >
                    {t('nav.pricing')}
                  </Link>
                </SheetClose>
              </li>
            </ul>

            {isAuthenticated ? null : (
              <div className="flex flex-col gap-2">
                <SheetClose asChild>
                  <Link to={pathTo(ROUTES.AUTH.SIGNUP, language)} className={ctaVariants()}>
                    {t('nav.signUp')}
                  </Link>
                </SheetClose>
                <SheetClose asChild>
                  <Link
                    to={pathTo(ROUTES.AUTH.LOGIN, language)}
                    className={ctaVariants({ tone: 'secondary' })}
                  >
                    {t('nav.logIn')}
                  </Link>
                </SheetClose>
              </div>
            )}

            <div className="mt-auto flex flex-col gap-4 border-t pt-6">
              <div
                role="group"
                aria-label={t('nav.language')}
                className="flex gap-1 rounded-md bg-sunken p-1"
              >
                {availableLanguages.map((lng) => (
                  <button
                    key={lng}
                    type="button"
                    lang={lng}
                    aria-pressed={language === lng}
                    className={segment}
                    onClick={() => {
                      changeLanguage(lng);
                    }}
                  >
                    {LANGUAGE_NAMES[lng]}
                  </button>
                ))}
              </div>
              <div
                role="group"
                aria-label={t('nav.theme')}
                className="flex gap-1 rounded-md bg-sunken p-1"
              >
                {(['light', 'dark'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={theme === option}
                    className={segment}
                    onClick={() => {
                      setTheme(option);
                    }}
                  >
                    {t(`theme.${option}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

/** The public navigation: mark and name, Features, Pricing, then Log in and Sign up. */
export default function NavBar() {
  const { t } = useTranslation();
  const isAuthenticated = useSelector(selectIsAuthenticated);
  const { language } = useLanguage();
  const { Logo } = assets;
  const home = pathTo(ROUTES.HOME, language);

  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 pt-[var(--safe-top)] backdrop-blur-md supports-[backdrop-filter]:bg-background/75">
      <nav
        aria-label={t('nav.primary')}
        className="mx-auto flex h-14 max-w-[1200px] items-center gap-1 px-4 sm:px-6 lg:px-8"
      >
        <Link
          to={home}
          className="me-3 flex shrink-0 items-center rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Logo className="text-base" />
        </Link>

        <div className="hidden items-center md:flex">
          <Link to={{ pathname: home, hash: '#features' }} className={navLink}>
            {t('nav.features')}
          </Link>
          <Link to={pathTo(ROUTES.PRICING, language)} className={navLink}>
            {t('nav.pricing')}
          </Link>
        </div>

        <div className="ms-auto flex items-center gap-1">
          <div className="hidden items-center md:flex">
            <LanguageSwitcher />
            <ModeToggle />
          </div>
          {isAuthenticated ? (
            <UserMenu />
          ) : (
            <>
              <Link
                to={pathTo(ROUTES.AUTH.LOGIN, language)}
                className={cn(navLink, 'hidden text-foreground md:inline-flex')}
              >
                {t('nav.logIn')}
              </Link>
              <Link
                to={pathTo(ROUTES.AUTH.SIGNUP, language)}
                className={cn(ctaVariants({ size: 'sm' }), 'ms-1')}
              >
                {t('nav.signUp')}
              </Link>
            </>
          )}
          <MobileMenu isAuthenticated={isAuthenticated} />
        </div>
      </nav>
    </header>
  );
}
