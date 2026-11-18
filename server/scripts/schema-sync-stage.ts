import { isStage, type Stage } from '../infra/lib/constants.js';

/**
 * The stage `npm run sync:schema:local -- <stage>` may sync (sync-schema-local.ts), from its
 * argument: dev or qa. Prod is refused: its schema changes only by its own deploy.
 */

export const SCHEMA_SYNC_LABEL = 'sync:schema:local';

export type SchemaSyncStage =
  | { ok: true; stage: Exclude<Stage, 'prod'> }
  | { ok: false; message: string };

export function schemaSyncStage(arg: string | undefined): SchemaSyncStage {
  if (!isStage(arg)) {
    return { ok: false, message: `Usage: npm run ${SCHEMA_SYNC_LABEL} -- <dev|qa>` };
  }
  if (arg === 'prod') {
    return {
      ok: false,
      message: 'refusing to sync prod from a checkout: its schema changes only by its own deploy.',
    };
  }
  return { ok: true, stage: arg };
}
