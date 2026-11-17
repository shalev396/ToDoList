import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { environment } from '../config/environment.js';
import { assertUnderTest } from '../config/testSwitches.js';
import { S3_PREFIXES } from '../../infra/lib/constants.js';
import { exportKeyFor } from '../constants/s3Folders.js';

/**
 * All uploaded files are stored under this prefix so they match
 * the CloudFront CacheBehavior `PathPattern: '/media/*'` that
 * routes to the assets S3 bucket.
 */
const MEDIA_PREFIX = S3_PREFIXES.media;

/**
 * Page size for every ListObjectsV2 call. The AWS SDK's XML deserializer has used fast-xml-parser,
 * which caps entity expansion at 1000; a full 1000-key page can exceed it and break list and
 * reset. Smaller pages stay well under the cap whatever parser the SDK ships.
 */
const LIST_OBJECTS_MAX_KEYS = 250;

/** Where an uploaded object is: its bucket URL, and the URL the frontend fetches. */
export interface ObjectUrls {
  s3Url: string;
  cloudfrontUrl: string;
}

export interface PresignedUpload {
  /** The bucket URL the browser POSTs a multipart form to. */
  url: string;
  /** Form fields to send before the `file` field, verbatim. */
  fields: Record<string, string>;
}

/**
 * The assets bucket (dependency inversion, like KeyProvider and Transport): S3 on a stage
 * (S3ObjectStore), a stand-in a test installs (setObjectStoreForTests;
 * testing/memoryObjectStore.ts keeps the objects in memory). The functions below are the app's
 * only way to the bucket, and each asks stageObjectStore.
 */
export interface ObjectStore {
  put(
    key: string,
    body: Buffer,
    contentType: string | null,
    contentDisposition?: string | null,
  ): Promise<void>;
  /** Throws an error named `NoSuchKey` (isS3NotFound) when there is no such object. */
  get(key: string): Promise<Buffer>;
  /** Size and stored Content-Type, or null when there is no such object. */
  head(key: string): Promise<{ size: number; contentType: string | null } | null>;
  delete(key: string): Promise<void>;
  /** Deletes all of these (in batches where the store has them). */
  deleteMany(keys: readonly string[]): Promise<void>;
  list(prefix: string): Promise<string[]>;
  urlsOf(key: string): ObjectUrls;
  presignedUpload(params: {
    s3Key: string;
    mimeType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload>;
  presignedDownloadUrl(key: string, expiresInSeconds: number): Promise<string>;
}

/**
 * The stage's bucket: the S3 assets bucket (S3_ASSETS_BUCKET_NAME, read on each call), served
 * under `/media/*` by CloudFront on DOMAIN_NAME. Making one never touches AWS.
 */
export class S3ObjectStore implements ObjectStore {
  readonly #client: S3Client;

  constructor(client: S3Client) {
    this.#client = client;
  }

  get #bucket(): string {
    return environment.s3AssetsBucketName;
  }

  async put(
    key: string,
    body: Buffer,
    contentType: string | null,
    contentDisposition: string | null = null,
  ): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ...(contentType === null ? {} : { ContentType: contentType }),
        ...(contentDisposition === null ? {} : { ContentDisposition: contentDisposition }),
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.#client.send(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key,
      }),
    );
    const chunks: Uint8Array[] = [];
    const stream = response.Body;
    if (!stream) throw new Error(`Empty response for S3 key: ${key}`);
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /** A 404 needs `s3:ListBucket` on the prefix; without it S3 answers 403, which is rethrown. */
  async head(key: string): Promise<{ size: number; contentType: string | null } | null> {
    try {
      const response = await this.#client.send(
        new HeadObjectCommand({
          Bucket: this.#bucket,
          Key: key,
        }),
      );
      return { size: response.ContentLength ?? 0, contentType: response.ContentType ?? null };
    } catch (error) {
      if (isS3NotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.#client.send(
      new DeleteObjectCommand({
        Bucket: this.#bucket,
        Key: key,
      }),
    );
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    const BATCH_SIZE = 1000;
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);
      await this.#client.send(
        new DeleteObjectsCommand({
          Bucket: this.#bucket,
          Delete: {
            Objects: batch.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefix,
          MaxKeys: LIST_OBJECTS_MAX_KEYS,
          ContinuationToken: continuationToken,
        }),
      );
      const contents = response.Contents ?? [];
      for (const obj of contents) {
        const key = obj.Key;
        if (typeof key === 'string' && key.length > 0) {
          keys.push(key);
        }
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken !== undefined);
    return keys;
  }

  urlsOf(key: string): ObjectUrls {
    return {
      s3Url: `https://${this.#bucket}.s3.${environment.awsRegion}.amazonaws.com/${key}`,
      cloudfrontUrl: `https://${environment.domainName}/${key}`,
    };
  }

  async presignedUpload(params: {
    s3Key: string;
    mimeType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload> {
    const { url, fields } = await createPresignedPost(this.#client, {
      Bucket: this.#bucket,
      Key: params.s3Key,
      Conditions: [
        ['content-length-range', 1, params.maxBytes],
        ['eq', '$Content-Type', params.mimeType],
      ],
      Fields: { 'Content-Type': params.mimeType },
      Expires: params.expiresInSeconds,
    });
    return { url, fields };
  }

  async presignedDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.#bucket,
      Key: key,
    });
    return await getSignedUrl(this.#client, command, { expiresIn: expiresInSeconds });
  }
}

const s3Store = new S3ObjectStore(new S3Client({ region: environment.awsRegion }));

let storeForTests: ObjectStore | null = null;

/**
 * Tests only (node:test): every function below uses `store` instead of the S3 bucket; null
 * restores S3. It throws in a server.
 */
export function setObjectStoreForTests(store: ObjectStore | null): void {
  assertUnderTest('setObjectStoreForTests');
  storeForTests = store;
}

/** The bucket this stage uses: the one a test installed, else S3. */
export function stageObjectStore(): ObjectStore {
  return storeForTests ?? s3Store;
}

interface UploadFileParams {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  /** Sub-folder under the enforced `media/` prefix (e.g. "users/{uid}") */
  folder: string;
}

interface UploadFileResult extends ObjectUrls {
  /** S3 object key path — used internally for SDK operations like delete */
  s3Key: string;
}

/**
 * Uploads a file to the S3 assets bucket under the `media/` prefix
 * (matching the CloudFront `/media/*` cache behavior) and returns
 * all three references.
 *
 * @example
 * const { s3Key, s3Url, cloudfrontUrl } = await uploadFile({
 *   buffer: fileBuffer,
 *   fileName: 'photo.jpg',
 *   mimeType: 'image/jpeg',
 *   folder: `users/${userId}`,
 * });
 * // s3Key        => "media/users/abc-123/d4e5f6.jpg"
 * // s3Url        => "https://my-bucket.s3.us-east-1.amazonaws.com/media/users/abc-123/d4e5f6.jpg"
 * // cloudfrontUrl => "https://example.com/media/users/abc-123/d4e5f6.jpg"
 */
export async function uploadFile(params: UploadFileParams): Promise<UploadFileResult> {
  const store = stageObjectStore();
  const ext = path.extname(params.fileName) || '';
  const uniqueName = `${randomUUID()}${ext}`;
  const s3Key = `${MEDIA_PREFIX}/${params.folder}/${uniqueName}`;
  await store.put(s3Key, params.buffer, params.mimeType);
  return { s3Key, ...store.urlsOf(s3Key) };
}

/**
 * Deletes a file from the S3 assets bucket by its key.
 */
export async function deleteFile(s3Key: string): Promise<void> {
  await stageObjectStore().delete(s3Key);
}

/**
 * Fetches a file from the S3 assets bucket and returns its contents as a Buffer.
 */
export async function getObjectBuffer(s3Key: string): Promise<Buffer> {
  return await stageObjectStore().get(s3Key);
}

/** True for the SDK's "object does not exist" errors (HeadObject: NotFound, GetObject: NoSuchKey). */
export function isS3NotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, $metadata } = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  return name === 'NotFound' || name === 'NoSuchKey' || $metadata?.httpStatusCode === 404;
}

/** True for S3's 403 (AccessDenied / Forbidden). */
export function isS3AccessDenied(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, $metadata } = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  return name === 'AccessDenied' || name === 'Forbidden' || $metadata?.httpStatusCode === 403;
}

/**
 * Size and stored Content-Type of an object without downloading it, or null when it does not
 * exist. A 404 needs `s3:ListBucket` on the prefix; without it S3 answers 403, which is rethrown.
 */
export async function headObject(
  s3Key: string,
): Promise<{ size: number; contentType: string | null } | null> {
  return await stageObjectStore().head(s3Key);
}

/**
 * A presigned POST for one object. Unlike a presigned PUT, the policy is enforced by S3 itself:
 * the body must be 1..maxBytes long and the Content-Type must equal `mimeType` exactly, so an
 * oversized or re-typed upload is rejected before it is ever stored.
 *
 * The policy is signed with the caller's credentials; on Lambda those are temporary role
 * credentials, so the form can stop working before `expiresInSeconds` if they expire first.
 */
export async function createPresignedUpload(params: {
  s3Key: string;
  mimeType: string;
  maxBytes: number;
  expiresInSeconds: number;
}): Promise<PresignedUpload> {
  return await stageObjectStore().presignedUpload(params);
}

/**
 * Returns a presigned GET URL for downloading an S3 object.
 */
export async function getPresignedDownloadUrl(
  s3Key: string,
  expiresInSeconds: number,
): Promise<string> {
  return await stageObjectStore().presignedDownloadUrl(s3Key, expiresInSeconds);
}

/**
 * Stores an account export ZIP under `tmp/exports/<userId>/` (never served by CloudFront; a
 * lifecycle rule deletes it after a day) and returns its key. The Content-Disposition keeps the
 * file name when the browser downloads it cross-origin through a presigned URL.
 */
export async function uploadExportZip(params: {
  userId: string;
  buffer: Buffer;
  filename: string;
}): Promise<string> {
  const s3Key = exportKeyFor(params.userId);
  const safeName = params.filename.replace(/["\\\r\n]/g, '_');
  await stageObjectStore().put(
    s3Key,
    params.buffer,
    'application/zip',
    `attachment; filename="${safeName}"`,
  );
  return s3Key;
}

/**
 * Lists all object keys under the given prefix in the assets bucket.
 */
export async function listObjectsInPrefix(prefix: string): Promise<string[]> {
  return await stageObjectStore().list(prefix);
}

/**
 * Deletes all user uploads under `media/`. Used by the dev reset endpoint. Staged uploads and
 * export ZIPs under `tmp/` are left alone: they expire by lifecycle rule within a day.
 */
export async function clearUserUploadedAssets(): Promise<void> {
  const keys = await listObjectsInPrefix(`${MEDIA_PREFIX}/`);
  if (keys.length === 0) return;
  await stageObjectStore().deleteMany(keys);
}
