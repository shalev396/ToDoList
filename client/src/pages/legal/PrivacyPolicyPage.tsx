import { useTranslation } from 'react-i18next';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import { LegalDocument } from './LegalDocument';

const SECTIONS = [
  'summary',
  'whoWeAre',
  'collect',
  'use',
  'promises',
  'sources',
  'google',
  'googleLimitedUse',
  'agents',
  'sharing',
  'travel',
  'secrets',
  'processors',
  'transfers',
  'retention',
  'security',
  'rights',
  'cookies',
  'children',
  'changes',
  'contact',
] as const;

export default function PrivacyPolicyPage() {
  const { t } = useTranslation();
  const { language } = useLanguage();

  return (
    <LegalDocument
      doc="privacy"
      sections={SECTIONS}
      other={{ to: pathTo(ROUTES.LEGAL.TERMS, language), label: t('legal.terms.title') }}
    />
  );
}
