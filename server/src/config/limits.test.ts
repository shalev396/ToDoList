import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CAPS } from '../types/builder.js';
import { PLAN_LIMITS } from '../types/limits.js';
import { LIMITS } from './limits.js';

describe('LIMITS (free tier)', () => {
  it('has exactly the agreed caps', () => {
    assert.deepEqual(LIMITS, {
      workspacesCreatedPerUser: 5,
      membersPerWorkspace: 25,
      integrationsPerUserPerWorkspace: 20,
      integrationsPerWorkspace: 100,
      agentKeysPerUser: 10,
      manualSyncIntervalMs: 300000,
      inviteEmailsPerWorkspacePerDay: 50,
      inviteResendCooldownMs: 600000,
      connectionTestsPerMinute: 5,
      providerCreatesPerHour: 30,
    });
  });

  it('cannot be changed at runtime', () => {
    assert.ok(Object.isFrozen(LIMITS));
  });
});

describe('PLAN_LIMITS (the one source the server and the pricing page share)', () => {
  it('has exactly the plan sizes the pricing page states', () => {
    assert.deepEqual(PLAN_LIMITS, {
      workspacesCreatedPerUser: 5,
      membersPerWorkspace: 25,
      integrationsPerUserPerWorkspace: 20,
      integrationsPerWorkspace: 100,
      agentKeysPerUser: 10,
      manualSyncIntervalMs: 300000,
      blocksPerPage: 40,
      viewsPerPage: 20,
      attributesPerWorkspace: 20,
      todosPerWorkspace: null,
      providerCreatesPerHour: 30,
      timeBlockExceptionsMax: 366,
      placesPerMember: 30,
      travelRulesPerMember: 50,
    });
  });

  it('cannot be changed at runtime', () => {
    assert.ok(Object.isFrozen(PLAN_LIMITS));
  });

  it('is what the server enforces', () => {
    for (const key of [
      'workspacesCreatedPerUser',
      'membersPerWorkspace',
      'integrationsPerUserPerWorkspace',
      'integrationsPerWorkspace',
      'agentKeysPerUser',
      'manualSyncIntervalMs',
    ] as const) {
      assert.equal(LIMITS[key], PLAN_LIMITS[key], key);
    }
    assert.equal(CAPS.maxBlocks, PLAN_LIMITS.blocksPerPage);
  });
});
