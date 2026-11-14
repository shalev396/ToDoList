import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { demoDataRefusal, isDemoDataStage } from './stage.js';

describe('demo data stages', () => {
  it('lets demo data load on dev and qa', () => {
    for (const env of ['dev', 'qa']) {
      assert.equal(isDemoDataStage(env), true, env);
      assert.equal(demoDataRefusal(env), null, env);
    }
  });

  it('refuses prod, anything else and a missing ENV, saying why', () => {
    for (const env of ['prod', 'local', 'production', 'Dev', ' qa', '']) {
      assert.equal(isDemoDataStage(env), false, env);
      assert.match(demoDataRefusal(env) ?? '', /only with ENV=dev or ENV=qa/, env);
    }
    assert.match(demoDataRefusal('prod') ?? '', /ENV is "prod"/);
    assert.equal(isDemoDataStage(undefined), false);
    assert.match(demoDataRefusal(undefined) ?? '', /ENV is not set/);
  });
});
