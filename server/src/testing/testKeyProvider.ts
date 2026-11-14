/**
 * Test-only: a deterministic stand-in for the stage's KMS key. The real KMS key provider
 * (services/crypto/keyProviders.ts) runs unchanged on a fake KMS client that wraps each data key
 * with AES-256-GCM under a fixed master key, bound to the EncryptionContext like KMS binds it: a
 * key wrapped for one context does not unwrap for another. Installed with setKeyProviderForTests.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { kmsKeyProvider, type KmsLikeClient } from '../services/crypto/keyProviders.js';

/** The envelope's KeyProvider, named without importing envelope.ts (vaultImports.test.ts). */
type KeyProvider = ReturnType<typeof kmsKeyProvider>;

/** The key id the test provider reports (never a real key). */
export const TEST_KMS_KEY_ID = 'alias/todolist-test-credentials';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The context as KMS compares it: every key and value, in key order. */
function contextAad(context: Record<string, string>): Buffer {
  const sorted = Object.keys(context)
    .sort()
    .map((key) => [key, context[key] ?? '']);
  return Buffer.from(JSON.stringify(sorted), 'utf8');
}

/** A KMS client that never leaves the process: GenerateDataKey and Decrypt, AES-256-GCM. */
export function fakeKmsClient(masterKey: Buffer = Buffer.alloc(32, 7)): KmsLikeClient {
  if (masterKey.length !== 32) throw new Error('The test master key must be 32 bytes');
  return {
    generateDataKey(input): ReturnType<KmsLikeClient['generateDataKey']> {
      const plaintext = randomBytes(32);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
      cipher.setAAD(contextAad(input.EncryptionContext));
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Promise.resolve({
        Plaintext: plaintext,
        CiphertextBlob: Buffer.concat([iv, cipher.getAuthTag(), body]),
        KeyId: input.KeyId,
      });
    },
    decrypt(input): ReturnType<KmsLikeClient['decrypt']> {
      const blob = Buffer.from(input.CiphertextBlob);
      const decipher = createDecipheriv('aes-256-gcm', masterKey, blob.subarray(0, IV_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(contextAad(input.EncryptionContext));
      decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const plaintext = Buffer.concat([
        decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
      return Promise.resolve({ Plaintext: plaintext });
    },
  };
}

/** The KMS key provider over the fake client: what tests seal and open credentials with. */
export function testKeyProvider(masterKey?: Buffer): KeyProvider {
  return kmsKeyProvider(fakeKmsClient(masterKey), TEST_KMS_KEY_ID);
}
