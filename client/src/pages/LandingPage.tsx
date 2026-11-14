import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { Faq } from '@/components/shared/Faq';
import { browserTimeZone } from '@/components/items/format';
import { useNow } from '@/hooks/useNow';
import { prefersReducedMotion } from '@/hooks/useReducedMotion';
import { ClosingCta } from '@/features/landing/Closing';
import { Features } from '@/features/landing/Features';
import { Flow } from '@/features/landing/Flow';
import { LandingHero } from '@/features/landing/LandingHero';
import { SourcesStrip } from '@/features/landing/SourcesStrip';

const LANDING_FAQ = [
  'sources',
  'sharing',
  'tokens',
  'agents',
  'languages',
  'free',
  'openSource',
] as const;

/**
 * The public home page: the live clock and deadlines first, then the sources, how it works, every
 * feature on sample data, common questions, and one closing section with the free plan and the
 * call to action.
 */
export default function LandingPage() {
  const { t } = useTranslation();
  // One clock for every demo on the page, ticking once a minute.
  const now = useNow();
  const timeZone = browserTimeZone();
  const { hash, key } = useLocation();

  // A link to a section (the nav's Features) scrolls there once the page has rendered.
  useEffect(() => {
    if (!hash) {
      return;
    }
    document
      .getElementById(decodeURIComponent(hash.slice(1)))
      ?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  }, [hash, key]);

  return (
    <>
      <PageMetadata title={t('landing.meta.title')} description={t('landing.meta.description')} />
      <LandingHero now={now} timeZone={timeZone} />
      <SourcesStrip />
      <Flow />
      <Features now={now} timeZone={timeZone} />
      <Faq items={LANDING_FAQ} className="border-t" />
      <ClosingCta />
    </>
  );
}
