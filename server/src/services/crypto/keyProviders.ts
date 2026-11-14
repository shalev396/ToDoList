/**
 * Where credential data keys come from: AWS KMS, one CMK per stage
 * (alias/todolist-<stage>-credentials). GenerateDataKey and Decrypt carry the EncryptionContext
 * {workspaceId, integrationId, provider}, so CloudTrail shows every decrypt and a key can't be
 * unwrapped for another context. Tests put their own provider in its place
 * (setKeyProviderForTests: testing/testKeyProvider.ts, a deterministic AES stand-in for KMS).
 */
import { assertUnderTest } from '../../config/testSwitches.js';
import type { DataKey, EncContext, KeyProvider } from './envelope.js';

/** The two KMS calls the provider needs (KMSClient-compatible, injectable in tests). */
export interface KmsLikeClient {
  generateDataKey(input: {
    KeyId: string;
    KeySpec: 'AES_256';
    EncryptionContext: Record<string, string>;
  }): Promise<{
    Plaintext?: Uint8Array | undefined;
    CiphertextBlob?: Uint8Array | undefined;
    KeyId?: string | undefined;
  }>;
  decrypt(input: {
    CiphertextBlob: Uint8Array;
    KeyId: string;
    EncryptionContext: Record<string, string>;
  }): Promise<{ Plaintext?: Uint8Array | undefined }>;
}

function encryptionContext(ctx: EncContext): Record<string, string> {
  return { workspaceId: ctx.workspaceId, integrationId: ctx.integrationId, provider: ctx.provider };
}

export function kmsKeyProvider(client: KmsLikeClient, keyId: string): KeyProvider {
  return {
    name: 'aws-kms',
    keyVersion: 1,
    async generateDataKey(ctx: EncContext): Promise<DataKey> {
      const result = await client.generateDataKey({
        KeyId: keyId,
        KeySpec: 'AES_256',
        EncryptionContext: encryptionContext(ctx),
      });
      if (result.Plaintext === undefined || result.CiphertextBlob === undefined) {
        throw new Error('KMS returned no data key');
      }
      return {
        plaintext: Buffer.from(result.Plaintext),
        wrapped: Buffer.from(result.CiphertextBlob),
        keyArn: result.KeyId ?? keyId,
      };
    },
    async decryptDataKey(wrapped: Buffer, ctx: EncContext): Promise<Buffer> {
      const result = await client.decrypt({
        CiphertextBlob: wrapped,
        KeyId: keyId,
        EncryptionContext: encryptionContext(ctx),
      });
      if (result.Plaintext === undefined) throw new Error('KMS returned no plaintext');
      return Buffer.from(result.Plaintext);
    },
  };
}

/** Adapts the AWS SDK client; imported on first use, so importing this never loads the SDK. */
async function awsKmsClient(region: string): Promise<KmsLikeClient> {
  const { KMSClient, GenerateDataKeyCommand, DecryptCommand } = await import('@aws-sdk/client-kms');
  const kms = new KMSClient({ region });
  return {
    generateDataKey: async (input) => await kms.send(new GenerateDataKeyCommand(input)),
    decrypt: async (input) => await kms.send(new DecryptCommand(input)),
  };
}

export interface KeyProviderOptions {
  kmsKeyId?: string | undefined;
  region?: string | undefined;
  kmsClient?: KmsLikeClient | undefined;
}

/**
 * Builds the KMS key provider. The KMS client is created on first use, so constructing the
 * provider never touches AWS.
 */
export function createKeyProvider(options: KeyProviderOptions): KeyProvider {
  const keyId = options.kmsKeyId ?? '';
  if (keyId === '') throw new Error('KMS_KEY_ID is required for the credentials key provider');
  let client: Promise<KmsLikeClient> | null = null;
  const resolveClient = async (): Promise<KmsLikeClient> => {
    client ??=
      options.kmsClient !== undefined
        ? Promise.resolve(options.kmsClient)
        : awsKmsClient(options.region ?? 'us-east-1');
    return await client;
  };
  return kmsKeyProvider(
    {
      generateDataKey: async (input) => await (await resolveClient()).generateDataKey(input),
      decrypt: async (input) => await (await resolveClient()).decrypt(input),
    },
    keyId,
  );
}

let providerForTests: KeyProvider | null = null;

/**
 * Tests only (node:test): every seal and open uses `provider` instead of the stage's KMS key;
 * null restores KMS. It throws in a server.
 */
export function setKeyProviderForTests(provider: KeyProvider | null): void {
  assertUnderTest('setKeyProviderForTests');
  providerForTests = provider;
}

/** The provider a test installed, or null (always null in a server). */
export function keyProviderForTests(): KeyProvider | null {
  return providerForTests;
}
