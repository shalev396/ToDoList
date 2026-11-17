/**
 * H4: every workspace gets the built-in Importance attribute (rating 1-5, not deletable, renamable)
 * in `settings.attributes`. A workspace that already holds one (a rename, a rerun) is left alone.
 */
import { WORKSPACE_TABLE_NAME } from '../models/definitions/Workspace.js';
import { BUILTIN_IMPORTANCE } from '../types/attributes.js';
import type { Migration } from './types.js';

export const addImportanceAttribute: Migration = {
  id: '2026-11-14-add-importance-attribute',
  async run(db) {
    const workspaces = db.collection(WORKSPACE_TABLE_NAME);
    const builtIn = { ...BUILTIN_IMPORTANCE };
    const fresh = await workspaces.updateMany(
      { 'settings.attributes': { $exists: false } },
      { $set: { 'settings.attributes': [builtIn] } },
    );
    const missing = await workspaces.updateMany(
      { 'settings.attributes': { $exists: true, $not: { $elemMatch: { key: builtIn.key } } } },
      // The driver's PushOperator type does not model `$position` on a dotted path.
      { $push: { 'settings.attributes': { $each: [builtIn], $position: 0 } } } as never,
    );
    return { workspaces: fresh.modifiedCount + missing.modifiedCount };
  },
};
