/**
 * PERMISSIONS-V2 (migration point 17): a workspace is shared as a whole. Member `areaScope` is
 * dropped from memberships and from invites still waiting, so everyone sees the whole workspace.
 */
import { INVITE_TABLE_NAME } from '../models/definitions/Invite.js';
import { MEMBERSHIP_TABLE_NAME } from '../models/definitions/Membership.js';
import type { Migration } from './types.js';

const SCOPED = { areaScope: { $exists: true } };
const UNSET = { $unset: { areaScope: '' } };

export const dropAreaScope: Migration = {
  id: '2026-11-13-drop-area-scope',
  async run(db) {
    const memberships = await db.collection(MEMBERSHIP_TABLE_NAME).updateMany(SCOPED, UNSET);
    const invites = await db.collection(INVITE_TABLE_NAME).updateMany(SCOPED, UNSET);
    return { memberships: memberships.modifiedCount, invites: invites.modifiedCount };
  },
};
