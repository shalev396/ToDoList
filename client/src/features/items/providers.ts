import { SOURCE_SLOT_ORDER } from '@/components/items/sources';
import type { Provider as ItemsProvider } from '@/components/items/types';
import type { Provider } from '@api-types/domain';

/** A provider with its own colour slot (DESIGN.md); Slack and Notion are named but have none. */
export function isKnownProvider(provider: Provider): provider is ItemsProvider {
  return SOURCE_SLOT_ORDER.some((slot) => slot === provider);
}
