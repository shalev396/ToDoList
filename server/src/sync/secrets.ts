/**
 * The sync's only way to a provider secret (DATA.md §3.5, BACKEND.md §6).
 *
 * - fixtures mode: the callback gets `{}` and the vault is never loaded, let alone called.
 * - live mode: CredentialVault.decryptForSync(integrationId, fn). The plaintext exists only for
 *   the duration of `fn`; nothing here keeps it.
 *
 * Only runSync.ts (and tests) import this module. vaultImports.test.ts enforces that, and keeps
 * this file on the vault's allow-list as the sync's one door to it.
 */
import type { IntegrationData } from '../models/definitions/Integration.js';
import type { SyncMode } from '../types/env.d.ts';

export type ProviderSecret = Readonly<Record<string, string>>;

/** The part of services/crypto/credentialVault.ts the sync uses. */
export interface SyncVault {
  decryptForSync<T>(integrationId: string, fn: (secret: ProviderSecret) => Promise<T>): Promise<T>;
}

/**
 * Loads the vault on first use, so fixtures mode never loads it (nor the KMS client behind it).
 * The specifier is a literal: esbuild bundles the vault into the Lambda layer, where a variable
 * specifier would be resolved at run time next to the bundle and not found; tsc checks the vault
 * against SyncVault; and the vault import-graph test sees the edge.
 */
const loadRealVault = (): Promise<SyncVault> => import('../services/crypto/credentialVault.js');

let loadVault: () => Promise<SyncVault> = loadRealVault;

const NO_SECRET: ProviderSecret = Object.freeze({});

/** Runs `fn` with the integration's provider secret: `{}` in fixtures mode, decrypted in live mode. */
export async function withProviderSecret<T>(
  integration: Pick<IntegrationData, 'id'>,
  mode: SyncMode,
  fn: (secret: ProviderSecret) => Promise<T>,
): Promise<T> {
  if (mode === 'fixtures') return fn(NO_SECRET);
  const vault = await loadVault();
  return vault.decryptForSync(integration.id, fn);
}

/**
 * Tests only: replaces how the vault is loaded (a stub); null restores the real module. It throws
 * outside node:test (the runner sets NODE_TEST_CONTEXT in every test process), so code that
 * reaches this export in production can't swap the vault.
 */
export function setVaultLoaderForTests(loader: (() => Promise<SyncVault>) | null): void {
  if ((process.env['NODE_TEST_CONTEXT'] ?? '') === '') {
    throw new Error('setVaultLoaderForTests runs only under node:test');
  }
  loadVault = loader ?? loadRealVault;
}
