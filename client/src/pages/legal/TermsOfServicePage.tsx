import { useTranslation } from 'react-i18next';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import { LegalDocument } from './LegalDocument';

const SECTIONS = [
  'summary',
  'agreement',
  'eligibility',
  'free',
  'business',
  'account',
  'acceptableUse',
  'content',
  'responsibilities',
  'thirdParty',
  'openSource',
  'availability',
  'warranty',
  'liability',
  'ending',
  'law',
  'changes',
  'general',
  'contact',
] as const;

export default function TermsOfServicePage() {
  const { t } = useTranslation();
  const { language } = useLanguage();

  return (
    <LegalDocument
      doc="terms"
      sections={SECTIONS}
      other={{ to: pathTo(ROUTES.LEGAL.PRIVACY, language), label: t('legal.privacy.title') }}
    />
  );
}
