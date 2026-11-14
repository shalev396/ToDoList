import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { app, assets } from '@/data';
import { pathTo, ROUTES } from '@/router/routes';
import { useLanguage } from '@/hooks/useLanguage';

const footerLink =
  'rounded-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/**
 * Public footer: Pricing, Privacy, Terms and the GitHub repository, the copyright, and the
 * credit to the template TodoList is built on, the only place its name appears in the UI.
 */
export default function Footer() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { Logo } = assets;
  const year = new Date().getFullYear();
  const links = [
    { to: pathTo(ROUTES.PRICING, language), label: t('footer.pricing') },
    { to: pathTo(ROUTES.LEGAL.PRIVACY, language), label: t('footer.privacy') },
    { to: pathTo(ROUTES.LEGAL.TERMS, language), label: t('footer.terms') },
  ];

  return (
    <footer className="border-t bg-background">
      <div className="mx-auto max-w-[1200px] px-4 pt-10 pb-[calc(2.5rem+env(safe-area-inset-bottom))] sm:px-6 lg:px-8">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div className="flex flex-col gap-2">
            <Link
              to={pathTo(ROUTES.HOME, language)}
              className="flex w-fit items-center rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <Logo className="text-base" />
            </Link>
            <p className="text-[13px] text-muted-foreground">{t('footer.tagline')}</p>
          </div>
          <nav aria-label={t('footer.nav')}>
            <ul className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
              {links.map(({ to, label }) => (
                <li key={to}>
                  <Link to={to} className={footerLink}>
                    {label}
                  </Link>
                </li>
              ))}
              <li>
                <a
                  href={app.repositoryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={footerLink}
                >
                  {t('footer.github')}
                  <span className="sr-only"> {t('footer.newTab')}</span>
                </a>
              </li>
            </ul>
          </nav>
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t pt-6 text-[13px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>{t('footer.copyright', { year, name: app.name })}</p>
          <p>
            <Trans
              i18nKey="footer.credit"
              components={{
                creditLink: (
                  <a
                    href={app.templateRepoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-sm underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  />
                ),
              }}
            />
          </p>
        </div>
      </div>
    </footer>
  );
}
