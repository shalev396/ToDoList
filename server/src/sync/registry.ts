/**
 * Provider adapters, by provider. An adapter module registers itself when imported
 * (`registerAdapter(jiraAdapter)` at its top level) and sync/providers/index.ts imports every
 * adapter module. runSync.ts imports that index, so whatever runs a sync sees all adapters.
 */
import type { Provider } from '../types/domain.js';
import type { ProviderAdapter } from './types.js';

const adapters = new Map<Provider, ProviderAdapter>();

/** Registers an adapter under its provider. A second, different adapter for it is refused. */
export function registerAdapter(adapter: ProviderAdapter): void {
  const current = adapters.get(adapter.provider);
  if (current !== undefined && current !== adapter) {
    throw new Error(`A sync adapter for "${adapter.provider}" is already registered`);
  }
  adapters.set(adapter.provider, adapter);
}

export function getAdapter(provider: Provider): ProviderAdapter | null {
  return adapters.get(provider) ?? null;
}

/** Providers with an adapter, sorted. */
export function registeredProviders(): Provider[] {
  return [...adapters.keys()].sort();
}

/** Tests only: forgets the provider's adapter. False when there was none. */
export function unregisterAdapter(provider: Provider): boolean {
  return adapters.delete(provider);
}
