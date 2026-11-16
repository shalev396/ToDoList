import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

import {
  CREDENTIAL_TABLE_NAME,
  type CredentialData,
  type CredentialEnvelope,
  type ICredentialRepository,
  type KeyProviderName,
  type SealedCredential,
  type UpsertSealedCredentialInput,
} from '../definitions/Credential.js';
import { setFields, uuidIdField } from './common.js';

type CredentialFields = Omit<SealedCredential, 'id'> & { _id: string };
/** A document loaded without `+enc`. */
type CredentialMetaFields = Omit<CredentialFields, 'enc'>;

const KEY_PROVIDERS: readonly KeyProviderName[] = ['aws-kms'];

const encSchema = new mongoose.Schema<CredentialEnvelope>(
  {
    alg: { type: String, required: true },
    keyProvider: { type: String, enum: KEY_PROVIDERS, required: true },
    kmsKeyArn: { type: String, default: null },
    keyVersion: { type: Number, required: true },
    wrappedDataKey: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
    ciphertext: { type: String, required: true },
    aad: { type: String, required: true },
  },
  { _id: false },
);

/**
 * toJSON() / toObject() never carry the envelope, even on a document loaded with `+enc`, and
 * expose `id` instead of `_id` (DATA.md §0.3).
 */
function withoutSecrets(_doc: unknown, ret: object): Record<string, unknown> {
  const plain = ret as Record<string, unknown>;
  delete plain['enc'];
  plain['id'] = plain['_id'];
  delete plain['_id'];
  return plain;
}

const credentialSchema = new mongoose.Schema<CredentialFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    integrationId: { type: String, required: true },
    ownerUserId: { type: String, required: true },
    kind: { type: String, required: true },
    scopes: { type: [String], default: [] },
    // Never loaded unless a query asks for `+enc` (only the repository's findSealed does).
    enc: { type: encSchema, required: true, select: false },
    expiresAt: { type: Date, default: null },
    rotatedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    collection: CREDENTIAL_TABLE_NAME,
    toJSON: { transform: withoutSecrets },
    toObject: { transform: withoutSecrets },
  },
);

credentialSchema.index({ integrationId: 1 }, { unique: true });
credentialSchema.index({ workspaceId: 1 });
credentialSchema.index(
  { expiresAt: 1 },
  { partialFilterExpression: { expiresAt: { $type: 'date' } } },
);

export const CredentialMongoModel = mongoose.model<CredentialFields>(
  'Credential',
  credentialSchema,
);

/** Copies metadata only: whatever the document holds, the envelope is never copied. */
function toCredentialMeta(doc: CredentialMetaFields): CredentialData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    integrationId: doc.integrationId,
    ownerUserId: doc.ownerUserId,
    kind: doc.kind,
    scopes: [...doc.scopes],
    expiresAt: doc.expiresAt ?? null,
    rotatedAt: doc.rotatedAt ?? null,
    lastUsedAt: doc.lastUsedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toSealedCredential(doc: CredentialFields): SealedCredential {
  const { enc } = doc;
  return {
    ...toCredentialMeta(doc),
    version: doc.version,
    enc: {
      alg: enc.alg,
      keyProvider: enc.keyProvider,
      kmsKeyArn: enc.kmsKeyArn ?? null,
      keyVersion: enc.keyVersion,
      wrappedDataKey: enc.wrappedDataKey,
      iv: enc.iv,
      authTag: enc.authTag,
      ciphertext: enc.ciphertext,
      aad: enc.aad,
    },
  };
}

/** The write that stores a sealed credential; a new one takes `id`. */
function sealedUpdate(
  input: UpsertSealedCredentialInput,
  id: string,
): mongoose.UpdateQuery<unknown> {
  return {
    $set: {
      ownerUserId: input.ownerUserId,
      kind: input.kind,
      scopes: input.scopes ?? [],
      expiresAt: input.expiresAt ?? null,
      enc: input.enc,
      ...setFields(input, ['rotatedAt']),
    },
    // Any replacement moves the version on, so a refresh in flight can't overwrite it.
    $inc: { version: 1 },
    $setOnInsert: { _id: id },
  };
}

export const CredentialRepository: ICredentialRepository = {
  async upsertSealed(workspaceId, integrationId, input) {
    // A credential for this integration under another workspace makes the insert fail on the
    // unique integrationId index instead of overwriting it.
    const doc = await CredentialMongoModel.findOneAndUpdate(
      { workspaceId, integrationId },
      sealedUpdate(input, randomUUID()),
      { upsert: true, new: true, runValidators: true },
    ).lean<CredentialMetaFields>();
    return toCredentialMeta(doc);
  },

  // upsertSealed()'s writes without its `runValidators` (a bulk write has none): Credential seals
  // what it writes.
  async upsertSealedMany(workspaceId, entries) {
    if (entries.length === 0) return 0;
    const result = await CredentialMongoModel.bulkWrite(
      entries.map(({ integrationId, id, input }) => ({
        updateOne: {
          filter: { workspaceId, integrationId },
          update: sealedUpdate(input, id),
          upsert: true,
        },
      })),
      { ordered: true },
    );
    return result.upsertedCount;
  },

  async replaceSealedIf(workspaceId, integrationId, expectedVersion, enc) {
    // A credential made before versions existed has none: it is version 0.
    const versionIs =
      expectedVersion === 0
        ? { $or: [{ version: 0 }, { version: { $exists: false } }] }
        : { version: expectedVersion };
    const result = await CredentialMongoModel.updateOne(
      { workspaceId, integrationId, ...versionIs },
      { $set: { enc, rotatedAt: new Date() }, $inc: { version: 1 } },
    );
    return result.modifiedCount === 1;
  },

  async findSealed(workspaceId, integrationId) {
    const doc = await CredentialMongoModel.findOne({ workspaceId, integrationId })
      .select('+enc')
      .lean<CredentialFields>();
    return doc ? toSealedCredential(doc) : null;
  },

  async findMetaMany(workspaceId, integrationIds) {
    if (integrationIds.length === 0) return [];
    const docs = await CredentialMongoModel.find({
      workspaceId,
      integrationId: { $in: [...integrationIds] },
    }).lean<CredentialMetaFields[]>();
    return docs.map(toCredentialMeta);
  },

  async findMeta(workspaceId, integrationId) {
    const doc = await CredentialMongoModel.findOne({
      workspaceId,
      integrationId,
    }).lean<CredentialMetaFields>();
    return doc ? toCredentialMeta(doc) : null;
  },

  async touch(workspaceId, integrationId, at) {
    // A decrypt is a use, not an edit: updatedAt stays.
    await CredentialMongoModel.updateOne(
      { workspaceId, integrationId },
      { $set: { lastUsedAt: at } },
      { timestamps: false },
    );
  },

  async delete(workspaceId, integrationId) {
    const result = await CredentialMongoModel.deleteOne({ workspaceId, integrationId });
    return result.deletedCount > 0;
  },

  async deleteForWorkspace(workspaceId) {
    const result = await CredentialMongoModel.deleteMany({ workspaceId });
    return result.deletedCount;
  },
};
