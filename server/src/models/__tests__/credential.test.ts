import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type { CredentialEnvelope } from '../definitions/Credential.js';
import { CredentialMongoModel, CredentialRepository } from '../mongoose/Credential.js';

const ENVELOPE: CredentialEnvelope = {
  alg: 'AES-256-GCM',
  keyProvider: 'aws-kms',
  kmsKeyArn: null,
  keyVersion: 1,
  wrappedDataKey: 'FAKE-wrapped-data-key',
  iv: 'FAKE-iv',
  authTag: 'FAKE-auth-tag',
  ciphertext: 'FAKE-ciphertext-of-the-token',
  aad: 'w-cred|i-cred|jira',
};

/** What must never appear outside findSealed(). */
const SECRET_MARKERS = ['"enc"', 'ciphertext', 'wrappedDataKey', 'authTag', 'FAKE-'];

function assertNoSecrets(value: unknown): void {
  const json = JSON.stringify(value);
  for (const marker of SECRET_MARKERS) assert.ok(!json.includes(marker), `found ${marker}`);
}

let db: TestDatabase;

before(async () => {
  db = await startTestDatabase('todolist_credential_test');
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
  await CredentialRepository.upsertSealed('w-cred', 'i-cred', {
    ownerUserId: 'u-owner',
    kind: 'api_token',
    scopes: ['read:jira-work'],
    expiresAt: new Date('2027-11-01T00:00:00Z'),
    enc: ENVELOPE,
  });
});

after(async () => {
  await db.stop();
});

describe('Credentials never expose the sealed envelope (DATA.md §0)', () => {
  it('JSON.stringify of a model document loaded with +enc holds no enc, ciphertext or wrappedDataKey', async () => {
    const raw = await CredentialMongoModel.findOne({ integrationId: 'i-cred' }).select('+enc');
    assert.ok(raw);
    // The document did load enc, so the transform is what keeps it out.
    assert.equal(raw.enc.ciphertext, ENVELOPE.ciphertext);
    assertNoSecrets(raw);
    const plain = raw.toObject() as Record<string, unknown>;
    assertNoSecrets(plain);
    assert.ok(!('_id' in plain));
    assert.equal(plain['id'], raw._id);
  });

  it('CredentialMongoModel.findOne() without +enc has no enc', async () => {
    const doc = await CredentialMongoModel.findOne({ integrationId: 'i-cred' });
    assert.ok(doc);
    assert.equal(doc.get('enc'), undefined);
    const lean = await CredentialMongoModel.findOne({ integrationId: 'i-cred' }).lean();
    assert.ok(lean);
    assert.ok(!('enc' in lean));
  });

  it('findMeta (and upsertSealed) return metadata only', async () => {
    const meta = await CredentialRepository.findMeta('w-cred', 'i-cred');
    assert.ok(meta);
    assert.ok(!('enc' in meta));
    assertNoSecrets(meta);
    assert.deepEqual(Object.keys(meta).sort(), [
      'createdAt',
      'expiresAt',
      'id',
      'integrationId',
      'kind',
      'lastUsedAt',
      'ownerUserId',
      'rotatedAt',
      'scopes',
      'updatedAt',
      'workspaceId',
    ]);
    const upserted = await CredentialRepository.upsertSealed('w-cred', 'i-meta', {
      ownerUserId: 'u-owner',
      kind: 'api_token',
      enc: ENVELOPE,
    });
    assertNoSecrets(upserted);
  });

  it('findSealed returns the envelope, for the credential vault', async () => {
    const sealed = await CredentialRepository.findSealed('w-cred', 'i-cred');
    assert.ok(sealed);
    assert.deepEqual(sealed.enc, ENVELOPE);
    assert.equal(sealed.kind, 'api_token');
  });

  it('upsertSealed replaces the envelope: one credential per integration', async () => {
    const rotatedAt = new Date();
    const replaced = await CredentialRepository.upsertSealed('w-cred', 'i-rotate', {
      ownerUserId: 'u-owner',
      kind: 'api_token',
      enc: ENVELOPE,
    });
    const again = await CredentialRepository.upsertSealed('w-cred', 'i-rotate', {
      ownerUserId: 'u-owner',
      kind: 'api_token',
      rotatedAt,
      enc: { ...ENVELOPE, ciphertext: 'FAKE-new-ciphertext', keyVersion: 2 },
    });
    assert.equal(again.id, replaced.id);
    assert.deepEqual(again.rotatedAt, rotatedAt);
    const sealed = await CredentialRepository.findSealed('w-cred', 'i-rotate');
    assert.equal(sealed?.enc.ciphertext, 'FAKE-new-ciphertext');
    assert.equal(await CredentialMongoModel.countDocuments({ integrationId: 'i-rotate' }), 1);
  });

  it('delete removes the credential for good', async () => {
    assert.equal(await CredentialRepository.delete('w-cred', 'i-rotate'), true);
    assert.equal(await CredentialRepository.findMeta('w-cred', 'i-rotate'), null);
    assert.equal(await CredentialMongoModel.countDocuments({ integrationId: 'i-rotate' }), 0);
    assert.equal(await CredentialRepository.delete('w-cred', 'i-rotate'), false);
  });

  it('touch records a use without bumping updatedAt', async () => {
    const stored = await CredentialRepository.upsertSealed('w-touch', 'i-touch', {
      ownerUserId: 'u-owner',
      kind: 'api_token',
      enc: ENVELOPE,
    });
    const usedAt = new Date(Date.now() + 5000);
    await CredentialRepository.touch('w-touch', 'i-touch', usedAt);
    const meta = await CredentialRepository.findMeta('w-touch', 'i-touch');
    assert.deepEqual([meta?.lastUsedAt, meta?.updatedAt], [usedAt, stored.updatedAt]);
    // Another workspace's id changes nothing.
    await CredentialRepository.touch('w-other', 'i-touch', new Date(0));
    assert.deepEqual(
      (await CredentialRepository.findMeta('w-touch', 'i-touch'))?.lastUsedAt,
      usedAt,
    );
  });

  it('deleteForWorkspace hard-deletes every credential of that workspace only', async () => {
    for (const integrationId of ['i-workspace-1', 'i-workspace-2']) {
      await CredentialRepository.upsertSealed('w-workspace-gone', integrationId, {
        ownerUserId: 'u-owner',
        kind: 'api_token',
        enc: ENVELOPE,
      });
    }
    await CredentialRepository.upsertSealed('w-workspace-kept', 'i-workspace-3', {
      ownerUserId: 'u-owner',
      kind: 'api_token',
      enc: ENVELOPE,
    });
    assert.equal(await CredentialRepository.deleteForWorkspace('w-workspace-gone'), 2);
    assert.equal(await CredentialMongoModel.countDocuments({ workspaceId: 'w-workspace-gone' }), 0);
    assert.ok(await CredentialRepository.findMeta('w-workspace-kept', 'i-workspace-3'));
    assert.equal(await CredentialRepository.deleteForWorkspace('w-workspace-gone'), 0);
  });
});
