/**
 * PERMISSIONS-V2 ruling 6 for members who left before the upgrade. Before it, leaving, removal
 * and account deletion left integrations alone (they were the workspace's); integration-owners
 * then made each one its connecting member's, even when that member had gone. Nobody could manage
 * such an integration any more, yet it kept syncing on their credential. So, for every live
 * integration whose owner has no active membership in its workspace, as a disconnect would:
 * 1. the integration gets `deletedAt` (the dispatcher and the vault stop at once);
 * 2. its credential is hard-deleted, then checked gone (a survivor fails the migration loudly);
 * 3. its items and containers are soft-deleted (the purge job removes them 30 days later);
 * and an `integration.disconnect` audit entry (actor `system`) records it. An OAuth grant is not
 * revoked at the provider: that needs the credential and the network, and the grant dies with the
 * deleted token anyway. Connector ids on blocks stay inert ("A source was removed").
 *
 * Runs after integration-owners. Idempotent: a deleted integration is never looked at again.
 */
import { randomUUID } from 'node:crypto';

import { AUDIT_LOG_TABLE_NAME } from '../models/definitions/AuditLog.js';
import { CONTAINER_TABLE_NAME } from '../models/definitions/Container.js';
import { CREDENTIAL_TABLE_NAME } from '../models/definitions/Credential.js';
import { INTEGRATION_TABLE_NAME } from '../models/definitions/Integration.js';
import { ITEM_TABLE_NAME } from '../models/definitions/Item.js';
import { MEMBERSHIP_TABLE_NAME } from '../models/definitions/Membership.js';
import type { Db, Migration } from './types.js';

type Doc = Record<string, unknown>;

export const orphanedIntegrations: Migration = {
  id: '2026-11-14-orphaned-integrations',
  async run(db: Db, now: Date) {
    const counts = { integrations: 0, credentials: 0, items: 0, containers: 0 };
    const integrations = db.collection<Doc>(INTEGRATION_TABLE_NAME);
    const memberships = db.collection<Doc>(MEMBERSHIP_TABLE_NAME);
    const credentials = db.collection<Doc>(CREDENTIAL_TABLE_NAME);
    const members = new Map<string, boolean>();
    const isMember = async (workspaceId: string, userId: string): Promise<boolean> => {
      const key = `${workspaceId}\u0000${userId}`;
      const known = members.get(key);
      if (known !== undefined) return known;
      const found =
        (await memberships.countDocuments({ workspaceId, userId, status: 'active' })) > 0;
      members.set(key, found);
      return found;
    };

    for await (const integration of integrations.find({ deletedAt: null })) {
      const workspaceId = String(integration['workspaceId']);
      const ownerUserId = integration['ownerUserId'];
      if (typeof ownerUserId === 'string' && (await isMember(workspaceId, ownerUserId))) continue;
      const integrationId = String(integration._id);
      const removed = await integrations.updateOne(
        { _id: integration._id, deletedAt: null },
        { $set: { deletedAt: now } },
      );
      if (removed.modifiedCount === 0) continue;
      counts.integrations += 1;
      counts.credentials += (
        await credentials.deleteMany({ workspaceId, integrationId })
      ).deletedCount;
      if ((await credentials.countDocuments({ workspaceId, integrationId })) > 0) {
        throw new Error('orphaned-integrations: a disconnect left its credential behind');
      }
      const live = { workspaceId, integrationId, deletedAt: null };
      counts.items += (
        await db.collection<Doc>(ITEM_TABLE_NAME).updateMany(live, { $set: { deletedAt: now } })
      ).modifiedCount;
      counts.containers += (
        await db
          .collection<Doc>(CONTAINER_TABLE_NAME)
          .updateMany(live, { $set: { deletedAt: now } })
      ).modifiedCount;
      await db.collection<Doc>(AUDIT_LOG_TABLE_NAME).insertOne({
        _id: randomUUID() as never,
        workspaceId,
        actorUserId: 'system',
        actorAgentId: null,
        action: 'integration.disconnect',
        targetType: 'integration',
        targetId: integrationId,
        ip: null,
        userAgent: null,
        meta: { provider: integration['provider'], reason: 'owner_not_a_member' },
        at: now,
      });
    }
    return counts;
  },
};
