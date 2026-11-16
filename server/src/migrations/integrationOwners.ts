/**
 * PERMISSIONS-V2 (migration point 17): integrations belong to one user inside one workspace.
 * Every integration without an owner gets its `connectedBy` as `ownerUserId`, deleted ones too
 * (an audit entry or a dangling connector may still name them). Idempotent: an owned integration
 * is left as it is.
 */
import { INTEGRATION_TABLE_NAME } from '../models/definitions/Integration.js';
import type { Migration } from './types.js';

export const integrationOwners: Migration = {
  id: '2026-11-14-integration-owners',
  async run(db) {
    const result = await db
      .collection(INTEGRATION_TABLE_NAME)
      .updateMany({ ownerUserId: { $exists: false } }, [{ $set: { ownerUserId: '$connectedBy' } }]);
    return { integrations: result.modifiedCount };
  },
};
