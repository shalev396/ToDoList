/**
 * The write side of the credential vault (DATA.md §3.5, §7; DECISIONS D14): it only encrypts. A
 * provider secret is sealed (AES-256-GCM under a fresh data key from KMS or the local master key,
 * bound to workspace|integration|provider) and stored; nothing here can decrypt. Reading a secret
 * back is credentialVault.ts, which only an allow-list of modules may import.
 */
import { Actor } from '../../classes/base/Actor.js';
import { AuditTarget } from '../../classes/base/AuditTarget.js';
import { AuditLog } from '../../classes/AuditLog.js';
import { AppError } from '../../errors/AppError.js';
import { getCredentialRepository, getIntegrationRepository } from '../../models/index.js';
import type { Provider } from '../../types/domain.js';
import { seal, type EncBlob } from './envelope.js';
import { stageKeyProvider } from './stageKeyProvider.js';

export interface StoreCredentialInput {
  workspaceId: string;
  integrationId: string;
  /** Must be the integration's provider: it is part of what the ciphertext is bound to. */
  provider: Provider;
  ownerUserId: string;
  kind: string;
  scopes?: string[] | undefined;
  /** Every secret the provider needs, e.g. Jira `{email, token}`. Write-only from here on. */
  secret: Record<string, string>;
  expiresAt?: Date | null | undefined;
}

/**
 * Seals and stores the integration's credential, replacing the one it has (`rotatedAt` is then
 * set), and links it as `Integration.credentialId`. Audited as `integration.connect` (the first
 * credential) or `credential.rotate` (a replacement), by `ownerUserId`. 404 for an unknown
 * integration.
 */
export async function storeCredential(input: StoreCredentialInput): Promise<void> {
  const { workspaceId, integrationId, provider } = input;
  const integrations = await getIntegrationRepository();
  const integration = await integrations.findById(workspaceId, integrationId);
  if (integration === null) throw new AppError(404, 'Integration not found');
  if (integration.provider !== provider) {
    throw new Error('storeCredential: the provider is not the integration’s');
  }
  const values = Object.values(input.secret);
  if (values.length === 0 || !values.every((value) => typeof value === 'string')) {
    throw new AppError(400, 'A secret is a non-empty set of text values');
  }

  const credentials = await getCredentialRepository();
  const replacing = (await credentials.findMeta(workspaceId, integrationId)) !== null;
  const plaintext = Buffer.from(JSON.stringify(input.secret), 'utf8');
  let enc: EncBlob;
  try {
    enc = await seal(plaintext, { workspaceId, integrationId, provider }, stageKeyProvider());
  } finally {
    plaintext.fill(0);
  }
  const stored = await credentials.upsertSealed(workspaceId, integrationId, {
    ownerUserId: input.ownerUserId,
    kind: input.kind,
    scopes: input.scopes ?? [],
    expiresAt: input.expiresAt ?? null,
    enc,
    ...(replacing ? { rotatedAt: new Date() } : {}),
  });
  if (integration.credentialId !== stored.id) {
    await integrations.update(workspaceId, integrationId, { credentialId: stored.id });
  }
  // No secret data (DATA.md §3.10): the credential is referenced by its id only.
  await AuditLog.record(
    { workspaceId, actor: Actor.user(input.ownerUserId) },
    replacing ? 'credential.rotate' : 'integration.connect',
    AuditTarget.integration(integrationId),
    { credentialId: stored.id, provider, kind: input.kind },
  );
}
