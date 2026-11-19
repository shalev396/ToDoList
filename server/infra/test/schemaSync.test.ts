import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { schemaSyncStage } from '../../scripts/schema-sync-stage.js';

/**
 * `npm run sync:schema:local -- <stage>` (scripts/sync-schema-local.ts): the PR-to-qa checks sync
 * the stage's schema with the branch's code before they run. Only its argument is tested here: the
 * sync itself is the deployed one's `syncDB()`, and nothing here may reach a real stage.
 */
describe('sync:schema:local stage', () => {
  it('takes dev and qa', () => {
    assert.deepEqual(schemaSyncStage('dev'), { ok: true, stage: 'dev' });
    assert.deepEqual(schemaSyncStage('qa'), { ok: true, stage: 'qa' });
  });

  it('refuses prod', () => {
    const prod = schemaSyncStage('prod');
    if (prod.ok) assert.fail('prod was taken');
    assert.match(prod.message, /refusing to sync prod/);
  });

  it('answers the usage for no stage or another word', () => {
    for (const arg of [undefined, '', 'staging', 'QA', '--', 'qa ']) {
      const parsed = schemaSyncStage(arg);
      if (parsed.ok) assert.fail(`${String(arg)} was taken`);
      assert.equal(parsed.message, 'Usage: npm run sync:schema:local -- <dev|qa>');
    }
  });
});
