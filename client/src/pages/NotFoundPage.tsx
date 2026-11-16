import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageMetadata } from '@/components/shared/PageMetadata';
import NavBar from '@/components/shared/NavBar';
import Footer from '@/components/shared/Footer';
import { ctaVariants } from '@/components/shared/cta-variants';
import { browserTimeZone } from '@/components/items/format';
import { ClockRing } from '@/features/dashboards/blocks/clock/ClockRing';
import { pageTitle } from '@/data/pageTitles';
import { useLanguage } from '@/hooks/useLanguage';
import { useNow } from '@/hooks/useNow';
import { pathTo, ROUTES } from '@/router/routes';

/** Nothing at this address: say so, show it, and offer the way home. */
export default function NotFoundPage() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { pathname } = useLocation();
  const now = useNow();

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <PageMetadata title={pageTitle(t('notFound.metaTitle'))} noIndex />
      <NavBar />
      <main className="flex flex-1 items-center">
        <div className="mx-auto grid w-full max-w-[1200px] grid-cols-1 items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-12 lg:px-8">
          <div className="lg:col-span-7">
            <h1 className="text-[2.75rem] leading-[1.05] font-semibold tracking-[-0.02em] lg:text-[4rem]">
              {t('notFound.title')}
            </h1>
            <p className="mt-6 max-w-[48ch] text-lg leading-relaxed text-muted-foreground">
              {t('notFound.body')}
            </p>
            <p className="mt-4 text-sm">
              <span className="sr-only">{t('notFound.address')}: </span>
              <code
                dir="ltr"
                className="inline-block max-w-full rounded-sm bg-sunken px-2 py-1 font-sans break-all text-foreground"
              >
                {pathname}
              </code>
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link to={pathTo(ROUTES.HOME, language)} className={ctaVariants()}>
                {t('notFound.home')}
              </Link>
              <Link
                to={pathTo(ROUTES.PRICING, language)}
                className={ctaVariants({ tone: 'secondary' })}
              >
                {t('notFound.pricing')}
              </Link>
            </div>
          </div>
          {/* The empty day: the clock with no events, only the needle. */}
          <div
            aria-hidden="true"
            className="hidden justify-center [--ring-surface:var(--background)] lg:col-span-5 lg:flex"
          >
            <ClockRing
              events={[]}
              now={now}
              timeZone={browserTimeZone()}
              size={320}
              labels={{
                summary: t('notFound.clock'),
                eventList: t('notFound.clock'),
                describeEvent: () => '',
              }}
            />
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
