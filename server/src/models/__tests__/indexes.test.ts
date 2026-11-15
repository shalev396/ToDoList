import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AgentKeyMongoModel } from '../mongoose/AgentKey.js';
import { AuditLogMongoModel } from '../mongoose/AuditLog.js';
import { CalendarLinkMongoModel } from '../mongoose/CalendarLink.js';
import { ContainerMongoModel } from '../mongoose/Container.js';
import { CredentialMongoModel } from '../mongoose/Credential.js';
import { DashboardMongoModel } from '../mongoose/Dashboard.js';
import { DashboardVersionMongoModel } from '../mongoose/DashboardVersion.js';
import { IntegrationMongoModel } from '../mongoose/Integration.js';
import { InviteMongoModel } from '../mongoose/Invite.js';
import { ItemMongoModel } from '../mongoose/Item.js';
import { McpAuthRequestMongoModel } from '../mongoose/McpAuthRequest.js';
import { McpClientMongoModel } from '../mongoose/McpClient.js';
import { MembershipMongoModel } from '../mongoose/Membership.js';
import { ReplayNonceMongoModel } from '../mongoose/ReplayNonce.js';
import { CreateQuotaMongoModel } from '../mongoose/CreateQuota.js';
import { SyncRunMongoModel } from '../mongoose/SyncRun.js';
import { SyncStateMongoModel } from '../mongoose/SyncState.js';
import { TopicMongoModel } from '../mongoose/Topic.js';
import { ViewMongoModel } from '../mongoose/View.js';
import { WorkspaceMongoModel } from '../mongoose/Workspace.js';

interface IndexSpec {
  key: Record<string, 1 | -1 | 'text'>;
  unique?: true;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
  weights?: Record<string, number>;
  default_language?: string;
}

const NOT_DELETED = { deletedAt: null };
const HAS_DATE = (field: string): Record<string, unknown> => ({ [field]: { $type: 'date' } });

/**
 * DATA.md §6, written out literally, plus:
 * - C1: Invites { email: 1, status: 1 };
 * - T3.2 fix round 1: Items and Containers { integrationId: 1, syncResource: 1, lastSeenAt: 1 }
 *   (added: per-resource sweep);
 * - H1 (PERMISSIONS-V2 ruling 8): an integration belongs to one member, so two members may
 *   connect one account: Integrations are unique per owner, and the Items and Containers natural
 *   key holds the integration (each integration keeps its own copies);
 * - H1 fix round 1: Dashboards { workspaceId: 1, 'blocks.connectors': 1 } and the same for the
 *   published copy, so "shared" (a connector on any block) never reads every dashboard.
 */
const EXPECTED: Record<string, IndexSpec[]> = {
  Workspaces: [
    { key: { slug: 1 }, unique: true },
    { key: { ownerId: 1 } },
    // A2: the join link's lookup, sparse so a workspace without a link is not indexed.
    { key: { 'joinLink.tokenHash': 1 }, unique: true },
  ],
  Memberships: [
    { key: { workspaceId: 1, userId: 1 }, unique: true },
    { key: { userId: 1, status: 1 } },
  ],
  Invites: [
    { key: { tokenHash: 1 }, unique: true },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    { key: { email: 1, status: 1 } },
  ],
  Integrations: [
    {
      key: { workspaceId: 1, ownerUserId: 1, provider: 1, accountId: 1 },
      unique: true,
      partialFilterExpression: NOT_DELETED,
    },
    { key: { status: 1, expiresAt: 1 } },
  ],
  Credentials: [
    { key: { integrationId: 1 }, unique: true },
    { key: { workspaceId: 1 } },
    { key: { expiresAt: 1 }, partialFilterExpression: HAS_DATE('expiresAt') },
  ],
  Items: [
    {
      key: {
        workspaceId: 1,
        'source.provider': 1,
        'source.accountId': 1,
        'source.externalId': 1,
        integrationId: 1,
      },
      unique: true,
    },
    { key: { workspaceId: 1, status: 1, dueAt: 1 }, partialFilterExpression: NOT_DELETED },
    { key: { workspaceId: 1, kind: 1, startAt: 1 }, partialFilterExpression: NOT_DELETED },
    { key: { workspaceId: 1, topicId: 1, status: 1 }, partialFilterExpression: NOT_DELETED },
    { key: { workspaceId: 1, containerId: 1, dueAt: 1 } },
    { key: { integrationId: 1, lastSeenAt: 1 } },
    // Added: per-resource sweep (T3.2 fix round 1).
    { key: { integrationId: 1, syncResource: 1, lastSeenAt: 1 } },
    { key: { deletedAt: 1 }, partialFilterExpression: HAS_DATE('deletedAt') },
    {
      // Phase 4a: a title override is searched too.
      key: { title: 'text', bodyPreview: 'text', 'overlay.overrides.title': 'text' },
      weights: { title: 5, bodyPreview: 1, 'overlay.overrides.title': 5 },
      default_language: 'none',
    },
    // H5: a to-do's provider copies
    {
      key: { workspaceId: 1, 'overlay.copyOf': 1 },
      partialFilterExpression: { 'overlay.copyOf': { $type: 'string' } },
    },
    // added: idempotent local create
    {
      key: { workspaceId: 1, ownerUserId: 1, 'props.idempotencyKey': 1 },
      unique: true,
      partialFilterExpression: { 'props.idempotencyKey': { $exists: true } },
    },
  ],
  Containers: [
    {
      key: {
        workspaceId: 1,
        'source.provider': 1,
        'source.accountId': 1,
        'source.externalId': 1,
        integrationId: 1,
      },
      unique: true,
    },
    { key: { workspaceId: 1, type: 1, topicId: 1 } },
    // Added: per-resource sweep (T3.2 fix round 1).
    { key: { integrationId: 1, syncResource: 1, lastSeenAt: 1 } },
  ],
  SyncStates: [{ key: { integrationId: 1, resource: 1 }, unique: true }],
  SyncRuns: [
    { key: { integrationId: 1, startedAt: -1 } },
    { key: { expireAt: 1 }, expireAfterSeconds: 0 },
    // Added: the purge job's stale-run reaper (T3.5); only running runs are in it.
    { key: { startedAt: 1 }, partialFilterExpression: { status: 'running' } },
  ],
  AuditLogs: [
    { key: { workspaceId: 1, at: -1 } },
    { key: { at: 1 }, expireAfterSeconds: 31536000 },
    {
      key: { workspaceId: 1, actorAgentId: 1, at: -1 },
      partialFilterExpression: { actorAgentId: { $type: 'string' } },
    },
  ],
  Dashboards: [
    {
      key: { workspaceId: 1, 'scope.topicId': 1, 'scope.containerId': 1 },
      partialFilterExpression: NOT_DELETED,
    },
    { key: { workspaceId: 1, ownerUserId: 1 } },
    { key: { workspaceId: 1, 'blocks.connectors': 1 }, partialFilterExpression: NOT_DELETED },
    {
      key: { workspaceId: 1, 'published.blocks.connectors': 1 },
      partialFilterExpression: NOT_DELETED,
    },
  ],
  DashboardVersions: [
    { key: { dashboardId: 1, version: -1 }, unique: true },
    { key: { workspaceId: 1, at: -1 } },
  ],
  Views: [{ key: { workspaceId: 1, title: 1 } }],
  // H2: a slug names one topic (page) of a workspace.
  Topics: [{ key: { workspaceId: 1, slug: 1 }, unique: true }],
  AgentKeys: [
    { key: { keyHash: 1 }, unique: true },
    // MCP sign-in grants: the refresh token's hash and the two tokens kept for a retried refresh.
    { key: { refreshHash: 1 }, unique: true },
    { key: { prevRefreshHash: 1 } },
    { key: { altRefreshHash: 1 } },
    { key: { sourceRequestId: 1 } },
    { key: { workspaceId: 1, userId: 1, revokedAt: 1 } },
    { key: { expiresAt: 1 }, partialFilterExpression: HAS_DATE('expiresAt') },
  ],
  CalendarLinks: [
    { key: { integrationId: 1, calendarId: 1, googleEventId: 1 }, unique: true },
    { key: { integrationId: 1, itemId: 1 }, unique: true },
    { key: { integrationId: 1, tombstonedAt: 1 }, partialFilterExpression: { tombstonedAt: null } },
    { key: { workspaceId: 1, calendarId: 1, googleEventId: 1 } },
    {
      key: { integrationId: 1, lastSweptAt: 1, tombstonedAt: 1 },
      partialFilterExpression: { deletedBy: 'dashboard', deleteAnsweredAt: { $type: 'null' } },
    },
  ],
  ReplayNonces: [{ key: { expireAt: 1 }, expireAfterSeconds: 0 }],
  CreateQuotas: [{ key: { expireAt: 1 }, expireAfterSeconds: 0 }],
  // MCP sign-in (global, not per workspace): a client is forgotten 30 days after its last use.
  McpClients: [{ key: { lastUsedAt: 1 }, expireAfterSeconds: 30 * 86400 }],
  // A request lives until it expires (TTL); an approved one is found by its code's hash.
  McpAuthRequests: [
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    {
      key: { codeHash: 1 },
      unique: true,
      partialFilterExpression: { codeHash: { $type: 'string' } },
    },
  ],
};

/** The parts of a Mongoose model this test reads. */
interface ModelWithIndexes {
  collection: { collectionName: string };
  schema: { indexes(): readonly (readonly [unknown, unknown])[] };
}

const MODELS: readonly ModelWithIndexes[] = [
  WorkspaceMongoModel,
  MembershipMongoModel,
  InviteMongoModel,
  IntegrationMongoModel,
  CredentialMongoModel,
  ItemMongoModel,
  ContainerMongoModel,
  SyncStateMongoModel,
  SyncRunMongoModel,
  AuditLogMongoModel,
  DashboardMongoModel,
  DashboardVersionMongoModel,
  ViewMongoModel,
  TopicMongoModel,
  AgentKeyMongoModel,
  CalendarLinkMongoModel,
  ReplayNonceMongoModel,
  CreateQuotaMongoModel,
  McpClientMongoModel,
  McpAuthRequestMongoModel,
];

const COMPARED_OPTIONS = [
  'unique',
  'expireAfterSeconds',
  'partialFilterExpression',
  'weights',
  'default_language',
] as const;

/** Key order matters in a compound index, so keys are compared as entry lists. */
function normalize(key: Record<string, unknown>, options: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = { key: Object.entries(key) };
  for (const name of COMPARED_OPTIONS) {
    const value = options[name];
    if (name === 'unique' ? value === true : value !== undefined) out[name] = value;
  }
  return out;
}

describe('collection indexes (DATA.md §6)', () => {
  it('covers exactly the collections listed', () => {
    const names = MODELS.map((model) => model.collection.collectionName).sort();
    assert.deepEqual(names, Object.keys(EXPECTED).sort());
  });

  for (const model of MODELS) {
    const name = model.collection.collectionName;
    it(`${name} declares exactly the §6 indexes, in order, via schema.index()`, () => {
      const actual = model.schema
        .indexes()
        .map(([key, options]) =>
          normalize(key as Record<string, unknown>, options as Record<string, unknown>),
        );
      const expected = (EXPECTED[name] ?? []).map(({ key, ...options }) => normalize(key, options));
      assert.deepEqual(actual, expected);
    });
  }
});
