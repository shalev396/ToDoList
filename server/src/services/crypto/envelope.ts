/**
 * Envelope encryption for provider credentials (DATA.md §7).
 *
 * seal(): a fresh 256-bit data key from the key provider (KMS GenerateDataKey) encrypts the
 * secret JSON with AES-256-GCM. The IV is random, the tag
 * is 16 bytes and the AAD is `workspaceId|integrationId|provider`. Only the wrapped data key is
 * stored; the plaintext key is zeroed. open() reverses it and fails on any tampering or on a
 * different context, so a ciphertext copied to another document can't be decrypted.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { KeyProviderName } from '../../models/definitions/Credential.js';

export interface EncContext {
  workspaceId: string;
  integrationId: string;
  provider: string;
}

/** What Credentials.enc stores. Every field is base64 except the metadata. */
export interface EncBlob {
  alg: 'AES-256-GCM';
  keyProvider: KeyProviderName;
  kmsKeyArn: string | null;
  keyVersion: number;
  wrappedDataKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  aad: string;
}

export interface DataKey {
  plaintext: Buffer;
  wrapped: Buffer;
  keyArn: string | null;
}

export interface KeyProvider {
  readonly name: KeyProviderName;
  readonly keyVersion: number;
  generateDataKey(ctx: EncContext): Promise<DataKey>;
  decryptDataKey(wrapped: Buffer, ctx: EncContext): Promise<Buffer>;
}

const IV_BYTES = 12;

export function aadFor(ctx: EncContext): string {
  return `${ctx.workspaceId}|${ctx.integrationId}|${ctx.provider}`;
}

export async function seal(plaintext: Buffer, ctx: EncContext, kp: KeyProvider): Promise<EncBlob> {
  const aad = aadFor(ctx);
  const key = await kp.generateDataKey(ctx);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key.plaintext, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      alg: 'AES-256-GCM',
      keyProvider: kp.name,
      kmsKeyArn: key.keyArn,
      keyVersion: kp.keyVersion,
      wrappedDataKey: key.wrapped.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      aad,
    };
  } finally {
    key.plaintext.fill(0);
  }
}

export async function open(blob: EncBlob, ctx: EncContext, kp: KeyProvider): Promise<Buffer> {
  const aad = aadFor(ctx);
  // The blob comes from the database: check its shape at runtime, not just its type.
  if (
    (blob.alg as string) !== 'AES-256-GCM' ||
    blob.aad !== aad ||
    (blob.keyProvider as string) !== kp.name
  ) {
    throw new Error('Credential does not match its context');
  }
  const dataKey = await kp.decryptDataKey(Buffer.from(blob.wrappedDataKey, 'base64'), ctx);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(blob.iv, 'base64'), {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(blob.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(blob.ciphertext, 'base64')),
      decipher.final(),
    ]);
  } finally {
    dataKey.fill(0);
  }
}
