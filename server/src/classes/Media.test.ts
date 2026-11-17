/**
 * Media keeps an uploaded file's object (the in-memory bucket here) and its row together
 * (phase 7c fix round, review m3): upload makes both, a failed row takes the object back, remove
 * and removeAllOf delete objects and rows, and deleting an account leaves none of the user's
 * files in the bucket (personal data).
 */
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { Media as MediaClass } from './Media.js';

let db: TestDatabase;

before(async () => {
  db = await startTestDatabase('todolist_classes_media');
});

after(async () => {
  mock.restoreAll();
  await db.stop();
});

async function media(): Promise<typeof MediaClass> {
  return (await import('./Media.js')).Media;
}

/** Not an image: the bytes pass through the metadata strip untouched. */
const BYTES = Buffer.from('not really a picture');

async function uploadFor(uploadedBy: string, fileName = 'photo.jpg'): Promise<MediaClass> {
  const Media = await media();
  return Media.upload({
    buffer: BYTES,
    fileName,
    mimeType: 'image/jpeg',
    folder: `users/${uploadedBy}`,
    uploadedBy,
  });
}

const keysOf = (): Promise<string[]> => db.seams.objects.list('media/');

describe('Media.upload', () => {
  it('stores the object under media/<folder>/ and creates its row with the stripped size', async () => {
    const Media = await media();
    const file = await uploadFor('u-up');
    assert.match(file.s3Key, /^media\/users\/u-up\//);
    assert.deepEqual(await db.seams.objects.get(file.s3Key), BYTES);
    const row = await Media.findById(file.id);
    assert.equal(row?.s3Key, file.s3Key);
    assert.equal(row.toJSON().size, BYTES.length);
    assert.equal(row.toJSON().uploadedBy, 'u-up');
  });

  it('takes the object back when the row cannot be made, and rethrows', async () => {
    const { getMediaRepository } = await import('../models/index.js');
    const repo = await getMediaRepository();
    const before = await keysOf();
    const create = mock.method(repo, 'create', () => Promise.reject(new Error('row refused')));
    try {
      await assert.rejects(uploadFor('u-fail'), /row refused/);
    } finally {
      create.mock.restore();
    }
    assert.deepEqual(await keysOf(), before);
    assert.deepEqual(await (await media()).findByUploadedBy('u-fail'), []);
  });
});

describe('Media.remove', () => {
  it('deletes the object and the row; a missing id is a no-op', async () => {
    const Media = await media();
    const keep = await uploadFor('u-rm', 'keep.jpg');
    const gone = await uploadFor('u-rm', 'gone.jpg');
    await Media.remove(gone.id);
    assert.equal(await Media.findById(gone.id), null);
    assert.equal(await db.seams.objects.head(gone.s3Key), null);
    assert.ok(await Media.findById(keep.id));
    assert.ok(await db.seams.objects.head(keep.s3Key));
    await Media.remove(gone.id);
    await Media.remove('000000000000000000000000');
    assert.ok(await Media.findById(keep.id));
  });
});

describe('Media.removeAllOf', () => {
  it('deletes the objects and rows of one uploader only', async () => {
    const Media = await media();
    const mine = [await uploadFor('u-all'), await uploadFor('u-all', 'b.jpg')];
    const theirs = await uploadFor('u-other');
    await Media.removeAllOf('u-all');
    assert.deepEqual(await Media.findByUploadedBy('u-all'), []);
    for (const file of mine) assert.equal(await db.seams.objects.head(file.s3Key), null);
    assert.ok(await Media.findById(theirs.id));
    assert.ok(await db.seams.objects.head(theirs.s3Key));
  });
});

describe('account deletion', () => {
  it('removes the user’s files from the bucket and their rows; another user’s stay', async () => {
    const { User } = await import('./User.js');
    const Media = await media();
    const user = await User.upsertFromLogin('sub-gone', 'gone@example.test', 'Gone');
    const mine = [await uploadFor(user.id), await uploadFor(user.id, 'second.png')];
    const other = await uploadFor('u-bystander');
    assert.ok(await db.seams.objects.head(mine[0]?.s3Key ?? ''));

    mock.method(console, 'error', () => undefined); // no user pool in the test stage
    // Through the controller: Media.removeAllOf is not mocked away, the real order runs.
    const { AccountController } = await import('../controllers/account.js');
    let answered: { status?: number; body?: unknown } = {};
    const res = {
      success: (body: unknown, status?: number): void => {
        answered = { body, ...(status === undefined ? {} : { status }) };
      },
      error: (message: string, status?: number): void => {
        answered = { body: message, ...(status === undefined ? {} : { status }) };
      },
    };
    const req = { user: { id: user.id, cognitoSub: 'sub-gone' }, headers: {}, ip: '203.0.113.5' };
    await AccountController.deleteAccount(req as never, res as never, () => undefined);
    assert.equal(answered.status, undefined, JSON.stringify(answered));

    assert.equal(await User.findById(user.id), null);
    for (const file of mine) assert.equal(await db.seams.objects.head(file.s3Key), null);
    assert.deepEqual(await Media.findByUploadedBy(user.id), []);
    assert.ok(await db.seams.objects.head(other.s3Key));
  });
});
