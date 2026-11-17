/**
 * The audit log records where a request came from (ip and userAgent) on the workspace, member,
 * invite, join-link, agent-key and credential actions too: the controllers pass the request's
 * actor down to the services that write those entries.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';

let api: ApiHarness;
let owner = '';
let editor = '';
let wid = '';

async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  return api.call(method, `/api/private${path}`, {
    token,
    ...(body === undefined ? {} : { body }),
  });
}

before(async () => {
  api = await startApiHarness('todolist_audit_origin_http');
  owner = (await api.login('origin-owner@example.test')).token;
  editor = (await api.login('origin-editor@example.test')).token;
  const created = await call(owner, 'POST', '/workspaces', { name: 'Origin' });
  assert.equal(created.status, 201, created.text);
  wid = (created.body?.['data'] as { id: string }).id;
  const models = await import('../../models/index.js');
  const user = await (await models.getUserRepository()).findByEmail('origin-editor@example.test');
  assert.ok(user);
  await (await models.getMembershipRepository()).create(wid, { userId: user.id, role: 'editor' });
});

after(async () => {
  await api.stop();
});

describe('the audit log’s origin fields', () => {
  it('are filled on the actions whose services used to drop the request', async () => {
    assert.equal(
      (await call(owner, 'PATCH', `/workspaces/${wid}`, { name: 'Origin 2' })).status,
      200,
    );
    const key = await call(owner, 'POST', `/workspaces/${wid}/agent-keys`, {
      name: 'k',
      scopes: ['read'],
    });
    assert.equal(key.status, 201, key.text);
    const keyId = (key.body?.['data'] as { id: string }).id;
    assert.equal(
      (await call(owner, 'DELETE', `/workspaces/${wid}/agent-keys/${keyId}`)).status,
      204,
    );
    const invite = await call(owner, 'POST', `/workspaces/${wid}/invites`, {
      email: 'origin-invitee@example.test',
      role: 'viewer',
    });
    assert.equal(invite.status, 201, invite.text);
    const link = await call(owner, 'PUT', `/workspaces/${wid}/join-link`, { enabled: true });
    assert.equal(link.status, 200, link.text);
    const integration = await call(owner, 'POST', `/workspaces/${wid}/integrations`, {
      provider: 'linear',
      config: {},
    });
    assert.equal(integration.status, 201, integration.text);
    const integrationId = (integration.body?.['data'] as { id: string }).id;
    const saved = await call(
      owner,
      'PUT',
      `/workspaces/${wid}/integrations/${integrationId}/credential`,
      {
        apiKey: 'lin_api_FAKE0123456789abcdefghij',
      },
    );
    assert.equal(saved.status, 204, saved.text);
    assert.equal((await call(editor, 'DELETE', `/workspaces/${wid}/members/me`)).status, 204);

    const { getAuditLogRepository } = await import('../../models/index.js');
    const entries = await (await getAuditLogRepository()).list(wid, {}, 100);
    const actions = [
      'workspace.create',
      'workspace.update',
      'agent_key.create',
      'agent_key.revoke',
      'member.invite',
      'workspace.link_update',
      'integration.create',
      'integration.connect',
      'member.leave',
    ];
    for (const action of actions) {
      const entry = entries.find((candidate) => candidate.action === action);
      assert.ok(entry, `no ${action} entry`);
      assert.equal(typeof entry.ip, 'string', `${action} has no ip`);
      assert.equal(typeof entry.userAgent, 'string', `${action} has no user agent`);
    }
  });
});
