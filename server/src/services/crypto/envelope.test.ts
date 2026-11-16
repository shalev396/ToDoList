import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { testKeyProvider } from '../../testing/testKeyProvider.js';
import { aadFor, open, seal, type EncContext } from './envelope.js';
import { createKeyProvider, kmsKeyProvider, type KmsLikeClient } from './keyProviders.js';

const CTX: EncContext = { workspaceId: 'w-1', integrationId: 'i-1', provider: 'jira' };
const SECRET = Buffer.from(
  JSON.stringify({ email: 'a@b.c', token: 'ATATT3xFAKEsecretvalue1234567890' }),
);
/** The KMS provider over the tests' fake KMS, with a master key of its own. */
const freshKey = (): ReturnType<typeof testKeyProvider> => testKeyProvider(randomBytes(32));

function flip(b64: string): string {
  const bytes = Buffer.from(b64, 'base64');
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return bytes.toString('base64');
}

describe('envelope (AES-256-GCM, AAD-bound)', () => {
  it('round-trips and stores no plaintext', async () => {
    const kp = freshKey();
    const blob = await seal(SECRET, CTX, kp);
    assert.equal(blob.alg, 'AES-256-GCM');
    assert.equal(blob.keyProvider, 'aws-kms');
    assert.equal(blob.aad, aadFor(CTX));
    assert.equal(JSON.stringify(blob).includes('ATATT3xFAKE'), false);
    assert.deepEqual(await open(blob, CTX, kp), SECRET);
  });

  it('uses a fresh IV and data key every time', async () => {
    const kp = freshKey();
    const a = await seal(SECRET, CTX, kp);
    const b = await seal(SECRET, CTX, kp);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.wrappedDataKey, b.wrappedDataKey);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });

  for (const field of ['ciphertext', 'authTag', 'iv', 'wrappedDataKey'] as const) {
    it(`fails when ${field} is tampered with`, async () => {
      const kp = freshKey();
      const blob = await seal(SECRET, CTX, kp);
      await assert.rejects(open({ ...blob, [field]: flip(blob[field]) }, CTX, kp));
    });
  }

  it('fails when the blob is opened for another workspace, integration or provider', async () => {
    const kp = freshKey();
    const blob = await seal(SECRET, CTX, kp);
    await assert.rejects(open(blob, { ...CTX, workspaceId: 'w-2' }, kp));
    await assert.rejects(open(blob, { ...CTX, integrationId: 'i-2' }, kp));
    await assert.rejects(open(blob, { ...CTX, provider: 'clickup' }, kp));
    // Even with the stored aad rewritten to match, the GCM tag and the wrapped key still bind the
    // original context.
    const moved = { ...blob, aad: aadFor({ ...CTX, workspaceId: 'w-2' }) };
    await assert.rejects(open(moved, { ...CTX, workspaceId: 'w-2' }, kp));
  });

  it('fails with a different master key', async () => {
    const blob = await seal(SECRET, CTX, freshKey());
    await assert.rejects(open(blob, CTX, freshKey()));
  });
});

/** In-memory stand-in for KMS: wraps data keys with one master key and checks the context. */
function fakeKms(): KmsLikeClient {
  const master = randomBytes(32);
  const contextOf = (ctx: Record<string, string> | undefined): string => JSON.stringify(ctx ?? {});
  return {
    async generateDataKey(input): ReturnType<KmsLikeClient['generateDataKey']> {
      const plaintext = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', master, iv);
      cipher.setAAD(Buffer.from(contextOf(input.EncryptionContext)));
      const wrapped = Buffer.concat([
        iv,
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return Promise.resolve({
        Plaintext: plaintext,
        CiphertextBlob: wrapped,
        KeyId: 'arn:aws:kms:us-east-1:123456789012:key/FAKE',
      });
    },
    async decrypt(input): ReturnType<KmsLikeClient['decrypt']> {
      const blob = Buffer.from(input.CiphertextBlob);
      const decipher = createDecipheriv('aes-256-gcm', master, blob.subarray(0, 12));
      decipher.setAAD(Buffer.from(contextOf(input.EncryptionContext)));
      decipher.setAuthTag(blob.subarray(blob.length - 16));
      const plaintext = Buffer.concat([
        decipher.update(blob.subarray(12, blob.length - 16)),
        decipher.final(),
      ]);
      return Promise.resolve({ Plaintext: plaintext });
    },
  };
}

describe('truncated GCM tags', () => {
  it('open rejects an auth tag shorter than 16 bytes', async () => {
    const kp = freshKey();
    const blob = await seal(SECRET, CTX, kp);
    const tag = Buffer.from(blob.authTag, 'base64');
    assert.equal(tag.length, 16);
    const truncated = { ...blob, authTag: tag.subarray(0, 4).toString('base64') };
    await assert.rejects(open(truncated, CTX, kp));
  });

  it('the fake KMS rejects a wrapped key whose tag is cut short', async () => {
    const kp = freshKey();
    const { wrapped } = await kp.generateDataKey(CTX);
    // iv(12) + a 4-byte stub of the 16-byte tag, and nothing after it.
    await assert.rejects(kp.decryptDataKey(wrapped.subarray(0, 16), CTX));
  });
});

describe('KMS key provider', () => {
  it('round-trips through KMS with the encryption context', async () => {
    const kp = kmsKeyProvider(fakeKms(), 'alias/todolist-dev-credentials');
    const blob = await seal(SECRET, CTX, kp);
    assert.equal(blob.keyProvider, 'aws-kms');
    assert.match(blob.kmsKeyArn ?? '', /^arn:aws:kms:/);
    assert.deepEqual(await open(blob, CTX, kp), SECRET);
    await assert.rejects(open(blob, { ...CTX, integrationId: 'i-9' }, kp));
  });
});

describe('createKeyProvider', () => {
  it('requires a KMS key id', () => {
    assert.throws(() => createKeyProvider({}), /KMS_KEY_ID/);
    assert.throws(() => createKeyProvider({ kmsKeyId: '' }), /KMS_KEY_ID/);
  });

  it('builds the KMS provider, which reaches KMS only on first use', async () => {
    let calls = 0;
    const kms = fakeKms();
    const counted: KmsLikeClient = {
      generateDataKey: (input) => {
        calls += 1;
        return kms.generateDataKey(input);
      },
      decrypt: (input) => {
        calls += 1;
        return kms.decrypt(input);
      },
    };
    const kp = createKeyProvider({
      kmsKeyId: 'alias/todolist-dev-credentials',
      kmsClient: counted,
    });
    assert.equal(kp.name, 'aws-kms');
    assert.equal(calls, 0);
    assert.deepEqual(await open(await seal(SECRET, CTX, kp), CTX, kp), SECRET);
    assert.equal(calls, 2);
  });
});
