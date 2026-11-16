import { useTranslation } from 'react-i18next';
import { PROVIDER_REGISTRY } from '@/features/integrations/providers';
import type { IconName } from '@/features/landing/ProviderIcon';
import type { FieldEntry } from './fieldOptions';

/** The provider's logo name, or null for a provider without one (local). */
export function providerIcon(provider: string): IconName | null {
  return provider in PROVIDER_REGISTRY
    ? PROVIDER_REGISTRY[provider as keyof typeof PROVIDER_REGISTRY].icon
    : null;
}

/** The name a field shows: translated for fixed fields, as written for attributes and provider fields. */
export function useFieldLabel(): (entry: FieldEntry | undefined, fallback?: string) => string {
  const { t } = useTranslation();
  return (entry, fallback = '') => {
    if (entry === undefined) {
      return fallback;
    }
    if (entry.label !== undefined) {
      return entry.label;
    }
    return t(`editor.fields.${entry.name}`, { defaultValue: entry.name });
  };
}
