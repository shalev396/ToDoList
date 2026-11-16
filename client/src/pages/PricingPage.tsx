import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { Faq } from '@/components/shared/Faq';
import { ctaVariants } from '@/components/shared/cta-variants';
import { sourceNameKey } from '@/components/items/sources';
import { app } from '@/data/app';
import { joinList, planFeatures, supportedIntegrations } from '@/data/pricing';
import { pageTitle } from '@/data/pageTitles';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';

const PRICING_FAQ = ['free', 'limits', 'openSource', 'leave', 'tokens', 'sharing'] as const;

const container = 'mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8';

/**
 * One plan, and it's free: what it includes (every number from the shared limits), a contact for
 * teams and schools, and questions.
 */
export default function PricingPage() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const integrations = joinList(
    supportedIntegrations.map((provider) => t(sourceNameKey(provider))),
    t('pricing.plan.list.separator'),
    t('pricing.plan.list.last'),
  );

  return (
    <>
      <PageMetadata
        title={pageTitle(t('pricing.meta.title'))}
        description={t('pricing.meta.description')}
      />
      <section
        aria-labelledby="pricing-title"
        className={`${container} pt-16 pb-12 lg:pt-24 lg:pb-16`}
      >
        <h1
          id="pricing-title"
          className="max-w-[16ch] text-[2.75rem] leading-[1.05] font-semibold tracking-[-0.02em] text-balance lg:text-[4rem]"
        >
          {t('pricing.title')}
        </h1>
        <p className="mt-6 max-w-[52ch] text-lg leading-relaxed text-muted-foreground lg:text-[1.3125rem]">
          {t('pricing.lead')}
        </p>
      </section>

      <section
        aria-labelledby="plan-title"
        className={`${container} grid grid-cols-1 items-start gap-6 pb-[72px] lg:grid-cols-12 lg:pb-32`}
      >
        <div className="rounded-lg border bg-card lg:col-span-8">
          <div className="flex flex-col gap-6 p-6 sm:flex-row sm:items-start sm:justify-between lg:p-8">
            <div>
              <h2 id="plan-title" className="text-[1.875rem] leading-tight font-semibold">
                {t('pricing.plan.name')}
              </h2>
              <p className="mt-2 flex flex-wrap items-baseline gap-x-2.5">
                <span className="text-[1.875rem] leading-none font-semibold tracking-[-0.02em]">
                  {t('pricing.plan.price')}
                </span>
                <span className="text-muted-foreground">{t('pricing.plan.period')}</span>
              </p>
              <p className="mt-4 max-w-[44ch] text-muted-foreground">
                {t('pricing.plan.description')}
              </p>
            </div>
            <Link to={pathTo(ROUTES.AUTH.SIGNUP, language)} className={ctaVariants()}>
              {t('pricing.plan.cta')}
            </Link>
          </div>
          <div className="border-t p-6 lg:p-8">
            <h3 className="text-sm font-semibold tracking-normal">
              {t('pricing.plan.includedTitle')}
            </h3>
            <ul className="mt-5 grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
              {planFeatures.map(({ id, title, detail }) => (
                <li key={id} data-plan-feature={id} className="flex gap-3">
                  <Check aria-hidden="true" className="mt-1 size-4 shrink-0" strokeWidth={2.25} />
                  <div className="min-w-0">
                    <p className="text-[15px] leading-snug font-medium">
                      {t(title.key, { ...title.values, list: integrations })}
                    </p>
                    {detail ? (
                      <p className="mt-1 text-sm leading-snug text-muted-foreground">
                        {t(detail.key, { ...detail.values, list: integrations })}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="flex flex-col items-start justify-start gap-4 rounded-lg border bg-card p-6 lg:col-span-4 lg:p-8">
          <div>
            <h2 className="text-base font-semibold tracking-normal">
              {t('pricing.business.title')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('pricing.business.body')}</p>
          </div>
          <a
            href={`mailto:${app.contactEmail}`}
            className={ctaVariants({ tone: 'secondary', className: 'shrink-0' })}
          >
            {t('pricing.business.cta')}
          </a>
        </div>
      </section>

      <Faq items={PRICING_FAQ} className="border-t" />
    </>
  );
}
