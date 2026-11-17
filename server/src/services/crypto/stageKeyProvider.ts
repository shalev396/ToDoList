/**
 * This stage's credential key provider (DATA.md §7): AWS KMS (KMS_KEY_ID, wired by CDK, or read
 * from the stack by local.ts), or the one a test installed (setKeyProviderForTests). Built on first
 * use; the KMS client is created on first use too, so importing this never touches AWS.
 */
import { environment } from '../../config/environment.js';
import type { KeyProvider } from './envelope.js';
import { createKeyProvider, keyProviderForTests } from './keyProviders.js';

let provider: KeyProvider | null = null;

export function stageKeyProvider(): KeyProvider {
  const forTests = keyProviderForTests();
  if (forTests !== null) return forTests;
  provider ??= createKeyProvider({
    kmsKeyId: process.env.KMS_KEY_ID,
    region: environment.awsRegion,
  });
  return provider;
}
