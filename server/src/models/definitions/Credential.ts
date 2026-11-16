/** Who wraps a credential's data key: AWS KMS, the only key provider. */
export type KeyProviderName = 'aws-kms';

/**
 * The sealed secret (DATA.md §7): AES-256-GCM ciphertext under a per-credential data key, wrapped
 * by KMS. Only the credential vault ever reads it.
 */
export interface CredentialEnvelope {
  alg: string;
  keyProvider: KeyProviderName;
  kmsKeyArn: string | null;
  keyVersion: number;
  wrappedDataKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  aad: string;
}

/** Credential metadata: everything but the envelope (DATA.md §3.5). */
export interface CredentialData {
  id: string;
  workspaceId: string;
  integrationId: string;
  ownerUserId: string;
  kind: string;
  scopes: string[];
  expiresAt: Date | null;
  rotatedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Metadata plus the envelope. Returned by findSealed() only. */
export interface SealedCredential extends CredentialData {
  enc: CredentialEnvelope;
  /** Counts replacements: the compare-and-set key of an OAuth refresh (replaceSealedIf). */
  version: number;
}

export interface UpsertSealedCredentialInput {
  ownerUserId: string;
  kind: string;
  scopes?: string[];
  expiresAt?: Date | null;
  /** Set when a token is replaced. */
  rotatedAt?: Date | null;
  enc: CredentialEnvelope;
}

/** One credential per integration. */
export interface ICredentialRepository {
  /**
   * Stores (or replaces) the integration's credential. Returns metadata only. The unique index
   * on `integrationId` (DATA.md §6) has no `workspaceId`: callers must first resolve the parent
   * integration with a workspace-scoped `findById`.
   */
  upsertSealed(
    workspaceId: string,
    integrationId: string,
    input: UpsertSealedCredentialInput,
  ): Promise<CredentialData>;
  /**
   * upsertSealed() for each entry, in one write, in order; a new credential takes `id`. How many
   * were new (no answer per credential). Same caveat as upsertSealed.
   */
  upsertSealedMany(
    workspaceId: string,
    entries: readonly { integrationId: string; id: string; input: UpsertSealedCredentialInput }[],
  ): Promise<number>;
  /**
   * Replaces the sealed secret only while the credential is still at `expectedVersion` (then the
   * version goes up by one): false when someone else replaced it first. An OAuth refresh uses it
   * so two refreshes at once never overwrite each other's rotated refresh token.
   */
  replaceSealedIf(
    workspaceId: string,
    integrationId: string,
    expectedVersion: number,
    enc: CredentialEnvelope,
  ): Promise<boolean>;
  /** The only method that returns `enc`: for the credential vault. */
  findSealed(workspaceId: string, integrationId: string): Promise<SealedCredential | null>;
  findMeta(workspaceId: string, integrationId: string): Promise<CredentialData | null>;
  /** findMeta() of each of these integrations that has a credential (one read). */
  findMetaMany(workspaceId: string, integrationIds: readonly string[]): Promise<CredentialData[]>;
  /** Records a use (`lastUsedAt`) without touching `updatedAt`: the vault calls it on decrypt. */
  touch(workspaceId: string, integrationId: string, at: Date): Promise<void>;
  /** Hard delete. False when there was nothing to delete. */
  delete(workspaceId: string, integrationId: string): Promise<boolean>;
  /** Hard delete of every credential of the workspace (workspace deletion). Returns how many. */
  deleteForWorkspace(workspaceId: string): Promise<number>;
}

export const CREDENTIAL_TABLE_NAME = 'Credentials';
