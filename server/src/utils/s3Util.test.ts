import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { S3Client } from '@aws-sdk/client-s3';
import { MemoryObjectStore } from '../testing/memoryObjectStore.js';
import {
  clearUserUploadedAssets,
  isS3AccessDenied,
  isS3NotFound,
  listObjectsInPrefix,
  S3ObjectStore,
  setObjectStoreForTests,
  stageObjectStore,
  uploadFile,
} from './s3Util.js';

const sdkError = (name: string, status: number): Error =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

describe('S3 error predicates', () => {
  it('recognizes a missing object from HeadObject and GetObject', () => {
    assert.equal(isS3NotFound(sdkError('NotFound', 404)), true);
    assert.equal(isS3NotFound(sdkError('NoSuchKey', 404)), true);
    assert.equal(isS3NotFound(sdkError('AccessDenied', 403)), false);
  });

  it('recognizes a 403', () => {
    assert.equal(isS3AccessDenied(sdkError('AccessDenied', 403)), true);
    assert.equal(isS3AccessDenied(sdkError('Forbidden', 403)), true);
    assert.equal(isS3AccessDenied(sdkError('NotFound', 404)), false);
  });

  it('ignores non-errors', () => {
    for (const value of [null, undefined, 'NotFound', 404]) {
      assert.equal(isS3NotFound(value), false);
      assert.equal(isS3AccessDenied(value), false);
    }
  });
});

describe('the ObjectStore seam', () => {
  /** An S3 client that records each command and answers with `answer(command)`. */
  function recordingClient(answer: (command: object) => unknown = () => ({})): {
    client: S3Client;
    sent: { name: string; input: Record<string, unknown> }[];
  } {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const client = {
      send: (command: { input: Record<string, unknown> }): Promise<unknown> => {
        sent.push({ name: command.constructor.name, input: command.input });
        try {
          return Promise.resolve(answer(command));
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    } as unknown as S3Client;
    return { client, sent };
  }

  it('S3ObjectStore puts into the stage bucket, a disposition only when given', async () => {
    process.env.S3_ASSETS_BUCKET_NAME = 'todolist-dev-assets-test';
    const { client, sent } = recordingClient();
    const store = new S3ObjectStore(client);
    await store.put('media/a.png', Buffer.from('x'), 'image/png');
    await store.put('tmp/e.zip', Buffer.from('y'), 'application/zip', 'attachment; filename="e"');
    assert.deepEqual(
      sent.map(({ name, input }) => [name, input['Bucket'], input['Key'], input['ContentType']]),
      [
        ['PutObjectCommand', 'todolist-dev-assets-test', 'media/a.png', 'image/png'],
        ['PutObjectCommand', 'todolist-dev-assets-test', 'tmp/e.zip', 'application/zip'],
      ],
    );
    assert.equal('ContentDisposition' in (sent[0]?.input ?? {}), false);
    assert.equal(sent[1]?.input['ContentDisposition'], 'attachment; filename="e"');
  });

  it('S3ObjectStore deletes many in batches of 1000, and reads a missing head as null', async () => {
    const { client, sent } = recordingClient((command) => {
      if (command.constructor.name === 'HeadObjectCommand') throw sdkError('NotFound', 404);
      return {};
    });
    const store = new S3ObjectStore(client);
    await store.deleteMany(Array.from({ length: 2500 }, (_, i) => `media/${String(i)}`));
    assert.deepEqual(
      sent.map(({ input }) => (input['Delete'] as { Objects: unknown[] }).Objects.length),
      [1000, 1000, 500],
    );
    assert.equal(await store.head('media/gone'), null);
  });

  it('S3ObjectStore rethrows a 403 head (no s3:ListBucket)', async () => {
    const { client } = recordingClient(() => {
      throw sdkError('AccessDenied', 403);
    });
    await assert.rejects(new S3ObjectStore(client).head('media/x'), /AccessDenied/);
  });

  it('S3ObjectStore names the bucket URL and the CloudFront URL', () => {
    process.env.S3_ASSETS_BUCKET_NAME = 'todolist-dev-assets-test';
    process.env.AWS_REGION = 'us-east-1';
    process.env.DOMAIN_NAME = 'example.test';
    assert.deepEqual(new S3ObjectStore(recordingClient().client).urlsOf('media/a.png'), {
      s3Url: 'https://todolist-dev-assets-test.s3.us-east-1.amazonaws.com/media/a.png',
      cloudfrontUrl: 'https://example.test/media/a.png',
    });
  });

  it('the app uses the store a test installs, and S3 again once it is removed', async () => {
    const memory = new MemoryObjectStore();
    setObjectStoreForTests(memory);
    try {
      assert.equal(stageObjectStore(), memory);
      const uploaded = await uploadFile({
        buffer: Buffer.from('png'),
        fileName: 'photo.png',
        mimeType: 'image/png',
        folder: 'users/u-1',
      });
      assert.match(uploaded.s3Key, /^media\/users\/u-1\/[0-9a-f-]{36}\.png$/);
      assert.equal(uploaded.cloudfrontUrl, memory.url(uploaded.s3Key));
      assert.deepEqual(await listObjectsInPrefix('media/'), [uploaded.s3Key]);
      await clearUserUploadedAssets();
      assert.deepEqual(await listObjectsInPrefix('media/'), []);
    } finally {
      setObjectStoreForTests(null);
    }
    assert.ok(stageObjectStore() instanceof S3ObjectStore);
  });
});
