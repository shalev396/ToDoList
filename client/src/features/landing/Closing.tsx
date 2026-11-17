import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ctaVariants } from '@/components/shared/cta-variants';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import { Container } from './layout';

/**
 * The page's one closing section: the free plan in a sentence, the call to create a workspace,
 * and the way to the full pricing page. Besides the hero, it is the only "Create your workspace".
 */
export function ClosingCta() {
  const { t } = useTranslation();
  const { language } = useLanguage();

  return (
    <section aria-labelledby="closing-title" className="border-t py-[72px] lg:py-32">
      <Container className="grid grid-cols-1 gap-8 lg:grid-cols-12 lg:items-end lg:gap-8">
        <div className="lg:col-span-7">
          <h2
            id="closing-title"
            className="max-w-[16ch] text-[1.875rem] leading-[1.1] font-semibold tracking-[-0.02em] text-balance lg:text-[2.75rem]"
          >
            {t('landing.closing.title')}
          </h2>
          <p className="mt-4 max-w-[52ch] text-lg text-muted-foreground">
            {t('landing.closing.body')}
          </p>
        </div>
        <div className="flex flex-wrap gap-3 lg:col-span-5 lg:justify-end">
          <Link to={pathTo(ROUTES.AUTH.SIGNUP, language)} className={ctaVariants()}>
            {t('landing.closing.cta')}
          </Link>
          <Link
            to={pathTo(ROUTES.PRICING, language)}
            className={ctaVariants({ tone: 'secondary' })}
          >
            {t('landing.closing.pricing')}
          </Link>
        </div>
      </Container>
    </section>
  );
}
