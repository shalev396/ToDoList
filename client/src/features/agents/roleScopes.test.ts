import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_SCOPES } from '@api-types/domain.ts';
import { scopesForRole } from './roleScopes.ts';

describe('scopesForRole', () => {
  it('viewer gets the read-side scopes only', () => {
    assert.deepEqual(scopesForRole('viewer'), [
      'read',
      'integrations:read',
      'integrations:connect',
      'workspace:read',
    ]);
  });

  it('editor lacks sharing, publishing and the owner-only scopes', () => {
    const scopes = scopesForRole('editor');
    assert.ok(scopes.includes('items:write'));
    assert.ok(!scopes.includes('workspace:share'));
    assert.ok(!scopes.includes('builder:publish'));
  });

  it('owner gets every scope', () => {
    assert.deepEqual(scopesForRole('owner'), [...AGENT_SCOPES]);
  });

  it('lists scopes in catalog order', () => {
    for (const role of ['viewer', 'editor', 'owner'] as const) {
      const scopes = scopesForRole(role);
      const order = scopes.map((scope) => AGENT_SCOPES.indexOf(scope));
      assert.deepEqual(
        order,
        [...order].sort((a, b) => a - b),
      );
    }
  });
});
