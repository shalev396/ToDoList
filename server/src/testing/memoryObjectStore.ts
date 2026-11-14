/**
 * Test-only: the S3 assets bucket in memory (utils/s3Util.ts, setObjectStoreForTests). Objects
 * keep their Content-Type and Content-Disposition; URLs are FAKE and never fetched.
 */
import type { PresignedUpload, TestObjectStore } from '../utils/s3Util.js';

interface StoredObject {
  body: Buffer;
  contentType: string | null;
  contentDisposition: string | null;
}

/** The origin every FAKE object URL uses. */
const ORIGIN = 'https://objects.test.invalid';

/** Same error name the S3 SDK uses, so isS3NotFound() keeps working. */
function notFound(): Error {
  const error = new Error('No such object');
  error.name = 'NoSuchKey';
  return error;
}

export class MemoryObjectStore implements TestObjectStore {
  readonly #objects = new Map<string, StoredObject>();

  put(
    key: string,
    body: Buffer,
    contentType: string | null,
    contentDisposition: string | null = null,
  ): Promise<void> {
    this.#objects.set(key, { body: Buffer.from(body), contentType, contentDisposition });
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer> {
    const object = this.#objects.get(key);
    return object === undefined ? Promise.reject(notFound()) : Promise.resolve(object.body);
  }

  head(key: string): Promise<{ size: number; contentType: string | null } | null> {
    const object = this.#objects.get(key);
    return Promise.resolve(
      object === undefined ? null : { size: object.body.length, contentType: object.contentType },
    );
  }

  delete(key: string): Promise<void> {
    this.#objects.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<string[]> {
    return Promise.resolve(
      [...this.#objects.keys()].filter((key) => key.startsWith(prefix)).sort(),
    );
  }

  url(key: string): string {
    return `${ORIGIN}/${key}`;
  }

  presignedUpload(params: { s3Key: string; mimeType: string; maxBytes: number }): PresignedUpload {
    return {
      url: `${ORIGIN}/upload`,
      fields: { key: params.s3Key, 'Content-Type': params.mimeType },
    };
  }

  /** Content-Disposition of a stored object, or null (for assertions). */
  dispositionOf(key: string): string | null {
    return this.#objects.get(key)?.contentDisposition ?? null;
  }
}
