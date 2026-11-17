/**
 * The import-order trap stays shut: this file loads the provider definitions, the request schemas
 * and the seed's credential shapes BEFORE its database starts (and before DATABASE_URL is set),
 * then uses the database. Nothing they load may fix the stage's configuration early
 * (config/environment.ts reads each value when it is asked for).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFINITIONS } from './index.js';
import { fakeCredential } from '../../../seed/fakeCredentials.js';
import { planConnection } from '../../../services/integrationConfig.js';
import { environment } from '../../../config/environment.js';
import { startTestDatabase, type TestDatabase } from '../../../testing/testDatabase.js';

let db: TestDatabase;

before(async () => {
  db = await startTestDatabase('todolist_definitions_import_order');
});

after(async () => {
  await db.stop();
});

describe('loading the definitions before the database starts', () => {
  it('fixes nothing early: the database set afterwards is the one used', async () => {
    assert.ok(DEFINITIONS.length > 0);
    assert.match(fakeCredential('personal_token', 'order')['token'] ?? '', /FAKE/);
    assert.equal(planConnection({ provider: 'clickup', config: {} }).provider, 'clickup');
    assert.equal(environment.databaseUrl, process.env.DATABASE_URL);
    assert.equal(environment.databaseProvider, 'mongoose');
    const { getIntegrationRepository } = await import('../../../models/index.js');
    assert.deepEqual(await (await getIntegrationRepository()).list('ws-import-order'), []);
  });
});
