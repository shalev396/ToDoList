/**
 * MongoDB `$jsonSchema` validators, installed by sync-db (`collMod`, validationLevel `moderate`,
 * validationAction `error`). A database-level guard against writers that bypass Mongoose
 * (DATA.md §3.6). Every validated collection also requires `workspaceId`.
 */
import { CONTAINER_TYPES, ITEM_KINDS, ITEM_STATUSES, PROVIDERS } from '../types/domain.js';
import { CONTAINER_TABLE_NAME } from './definitions/Container.js';
import { CREDENTIAL_TABLE_NAME } from './definitions/Credential.js';
import { ITEM_TABLE_NAME } from './definitions/Item.js';

/** `source` names its provider, external id and link (Items and Containers alike). */
const SOURCE = {
  bsonType: 'object',
  required: ['provider', 'externalId', 'url'],
  properties: {
    provider: { enum: [...PROVIDERS] },
    externalId: { bsonType: 'string' },
    url: { bsonType: 'string' },
  },
};

export const ITEMS_VALIDATOR = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['workspaceId', 'kind', 'topicId', 'title', 'status', 'source'],
    properties: {
      workspaceId: { bsonType: 'string' },
      kind: { enum: [...ITEM_KINDS] },
      // A topic's id, or null (Unsorted).
      topicId: { bsonType: ['string', 'null'] },
      title: { bsonType: 'string' },
      status: { enum: [...ITEM_STATUSES] },
      source: SOURCE,
    },
  },
};

export const CONTAINERS_VALIDATOR = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['workspaceId', 'type', 'source'],
    properties: {
      workspaceId: { bsonType: 'string' },
      type: { enum: [...CONTAINER_TYPES] },
      source: SOURCE,
    },
  },
};

const SEALED_PARTS = ['ciphertext', 'iv', 'authTag', 'wrappedDataKey', 'aad'] as const;

export const CREDENTIALS_VALIDATOR = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['workspaceId', 'integrationId', 'enc'],
    properties: {
      workspaceId: { bsonType: 'string' },
      integrationId: { bsonType: 'string' },
      enc: {
        bsonType: 'object',
        required: [...SEALED_PARTS],
        properties: Object.fromEntries(SEALED_PARTS.map((part) => [part, { bsonType: 'string' }])),
      },
    },
  },
};

/** Validators by collection name. Collections not listed have none. */
export const COLLECTION_VALIDATORS: Readonly<Partial<Record<string, Record<string, unknown>>>> = {
  [ITEM_TABLE_NAME]: ITEMS_VALIDATOR,
  [CONTAINER_TABLE_NAME]: CONTAINERS_VALIDATOR,
  [CREDENTIAL_TABLE_NAME]: CREDENTIALS_VALIDATOR,
};
