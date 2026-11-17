/**
 * Effective rights of an agent key (MCP.md §4): the key's scopes ∩ what the user's role permits
 * (DATA.md §5), and on /readonly only the read scopes. A key never exceeds its user.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_SCOPES, type AgentScope } from '../../types/domain.js';
import { canCall, effectiveScopes, endpointScopes, ROLE_SCOPES } from '../auth/scopes.js';

const ALL: AgentScope[] = [...AGENT_SCOPES];

describe('effectiveScopes', () => {
  it('gives a viewer the read scopes and their own integrations’ management, whatever the key holds', () => {
    assert.deepEqual(effectiveScopes(ALL, 'viewer'), [
      'read',
      'integrations:read',
      'integrations:connect',
      'workspace:read',
    ]);
  });

  it('gives an editor local writes, sync, the calendar push, the builder and connecting their own integrations, never sharing', () => {
    assert.deepEqual(effectiveScopes(ALL, 'editor'), [
      'read',
      'items:write',
      'sync',
      'gcal:write',
      'providers:create',
      'integrations:read',
      'integrations:connect',
      'workspace:read',
      'builder:write',
    ]);
  });

  it('gives an owner everything the key holds, and nothing it does not', () => {
    assert.deepEqual(effectiveScopes(ALL, 'owner'), ALL);
    assert.deepEqual(effectiveScopes(['workspace:read'], 'owner'), ['workspace:read']);
    assert.deepEqual(effectiveScopes([], 'owner'), []);
  });

  it('drops workspace:share from an editor key', () => {
    assert.deepEqual(effectiveScopes(['workspace:read', 'workspace:share'], 'editor'), [
      'workspace:read',
    ]);
  });

  it('returns scopes in catalog order without repeats', () => {
    assert.deepEqual(effectiveScopes(['workspace:read', 'read', 'read'], 'owner'), [
      'read',
      'workspace:read',
    ]);
  });

  it('every role permits a subset of the next one', () => {
    for (const scope of ROLE_SCOPES.viewer) assert.ok(ROLE_SCOPES.editor.includes(scope));
    for (const scope of ROLE_SCOPES.editor) assert.ok(ROLE_SCOPES.owner.includes(scope));
  });
});

describe('endpointScopes', () => {
  it('ignores write scopes on /readonly', () => {
    assert.deepEqual(endpointScopes(ALL, { readonly: true }), [
      'read',
      'integrations:read',
      'workspace:read',
    ]);
  });

  it('keeps every effective scope on /api/mcp', () => {
    assert.deepEqual(endpointScopes(['read', 'workspace:share'], { readonly: false }), [
      'read',
      'workspace:share',
    ]);
  });
});

describe('canCall', () => {
  const invite = {
    scopes: ['workspace:share'] as const,
    minRole: 'owner' as const,
    readOnly: false,
  };
  const list = { scopes: ['workspace:read'] as const, minRole: 'viewer' as const, readOnly: true };

  it('needs every scope of the tool', () => {
    assert.equal(canCall(invite, { role: 'owner', scopes: ['workspace:share'] }), true);
    assert.equal(canCall(invite, { role: 'owner', scopes: ['workspace:read'] }), false);
  });

  it('needs the minimum role even when the scope is present', () => {
    assert.equal(canCall(invite, { role: 'editor', scopes: ['workspace:share'] }), false);
    assert.equal(canCall(list, { role: 'viewer', scopes: ['workspace:read'] }), true);
  });

  it('allows only read-only tools on /readonly', () => {
    assert.equal(
      canCall(invite, { role: 'owner', scopes: ['workspace:share'] }, { readonly: true }),
      false,
    );
    assert.equal(
      canCall(list, { role: 'owner', scopes: ['workspace:read'] }, { readonly: true }),
      true,
    );
  });
});
