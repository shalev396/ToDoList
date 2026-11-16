/**
 * ScopeSet: an agent's scopes as an immutable value object, in catalog order, compared by value;
 * the effective scopes are the grant's ∩ the role's, exactly as ROLE_SCOPES reads.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_SCOPES,
  READ_ONLY_SCOPES,
  ROLE_SCOPES,
  ROLES,
  type AgentScope,
} from '../../types/domain.js';
import { Role } from './Role.js';
import { ScopeSet } from './ScopeSet.js';

describe('ScopeSet', () => {
  it('keeps the catalog order, drops repeats and names outside the catalog', () => {
    const set = ScopeSet.of(['workspace:read', 'read', 'read', 'nope', 'items:write']);
    assert.deepEqual(set.toArray(), ['read', 'items:write', 'workspace:read']);
    assert.equal(set.size, 3);
    assert.equal(set.has('nope'), false);
    assert.deepEqual(ScopeSet.of([]).toArray(), []);
  });

  it('is immutable: frozen, and its array is a fresh copy', () => {
    const set = ScopeSet.of(['read']);
    assert.ok(Object.isFrozen(set));
    const array = set.toArray();
    array.push('sync');
    assert.deepEqual(set.toArray(), ['read']);
    assert.deepEqual(JSON.parse(JSON.stringify({ set })), { set: ['read'] });
  });

  it('compares by value', () => {
    assert.ok(ScopeSet.of(['sync', 'read']).equals(ScopeSet.of(['read', 'sync', 'sync'])));
    assert.ok(!ScopeSet.of(['read']).equals(ScopeSet.of(['read', 'sync'])));
    assert.ok(!ScopeSet.of(['read']).equals(ScopeSet.of(['sync'])));
  });

  it('has, hasAll and intersect', () => {
    const set = ScopeSet.of(['read', 'sync', 'gcal:write']);
    assert.ok(set.has('sync'));
    assert.ok(set.hasAll(['read', 'gcal:write']));
    assert.ok(set.hasAll([]));
    assert.ok(!set.hasAll(['read', 'builder:publish']));
    assert.ok(!set.hasAll(['read', 'not-a-scope']));
    assert.deepEqual(set.intersect(ScopeSet.of(['gcal:write', 'read', 'items:write'])).toArray(), [
      'read',
      'gcal:write',
    ]);
  });

  it('forRole is ROLE_SCOPES, for a Role or its name', () => {
    for (const role of ROLES) {
      assert.deepEqual(ScopeSet.forRole(role).toArray(), [...ROLE_SCOPES[role]], role);
      assert.ok(ScopeSet.forRole(Role.of(role)).equals(ScopeSet.forRole(role)), role);
    }
  });

  it('effective is the grant ∩ the role, in catalog order, for every role and every single scope', () => {
    const ALL: AgentScope[] = [...AGENT_SCOPES];
    for (const role of ROLES) {
      const permitted = new Set(ROLE_SCOPES[role]);
      assert.deepEqual(
        ScopeSet.effective([...ALL].reverse(), role).toArray(),
        AGENT_SCOPES.filter((scope) => permitted.has(scope)),
        role,
      );
      for (const scope of ALL) {
        assert.deepEqual(
          ScopeSet.effective([scope], role).toArray(),
          permitted.has(scope) ? [scope] : [],
          `${role} ${scope}`,
        );
      }
    }
  });

  it('onEndpoint: all of it, or only the read scopes on /readonly', () => {
    const owner = ScopeSet.forRole('owner');
    assert.equal(owner.onEndpoint({ readonly: false }), owner);
    assert.deepEqual(owner.onEndpoint({ readonly: true }).toArray(), [...READ_ONLY_SCOPES]);
    assert.ok(ScopeSet.readOnly.equals(ScopeSet.of(READ_ONLY_SCOPES)));
  });
});
