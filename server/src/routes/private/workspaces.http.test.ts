/**
 * Workspace flows over HTTP (the API harness: the dev stage with test seams): sign-in status, create and edit,
 * the invite round trip (with the response guard), the default workspace, deletion and the
 * account deletion cascade.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS } from '../../config/limits.js';
import { startApiHarness, type ApiHarness } from '../../testing/apiHarness.js';
import { hashInviteToken } from '../../services/inviteTokens.js';
import { findSecrets } from '../../services/secretPatterns.js';

let api: ApiHarness;

before(async () => {
  api = await startApiHarness('todolist_workspaces_http');
});

after(async () => {
  await api.stop();
});

type Data = Record<string, unknown>;

function dataOf(res: { body: Record<string, unknown> | null }): Data {
  return res.body?.['data'] as Data;
}

async function signIn(label: string): Promise<{ token: string; id: string; email: string }> {
  const email = `${label}@example.test`;
  const { token } = await api.login(email);
  const me = await api.call('GET', '/api/private/me', { token });
  return { token, id: dataOf(me)['id'] as string, email };
}

async function createWorkspace(token: string, body: unknown): Promise<Data> {
  const res = await api.call('POST', '/api/private/workspaces', { token, body });
  assert.equal(res.status, 201, res.text);
  return dataOf(res);
}

describe('sign-in and /me report workspaces', () => {
  it('a new user has none; after creating one, it is the default', async () => {
    const first = await api.login('newcomer@example.test');
    assert.equal(first.data['hasWorkspaces'], false);
    assert.equal(first.data['defaultWorkspaceId'], null);

    const workspace = await createWorkspace(first.token, { name: 'First workspace' });
    const again = await api.login('newcomer@example.test');
    assert.equal(again.data['hasWorkspaces'], true);
    assert.equal(again.data['defaultWorkspaceId'], workspace['id']);

    const me = dataOf(await api.call('GET', '/api/private/me', { token: again.token }));
    assert.deepEqual([me['hasWorkspaces'], me['defaultWorkspaceId']], [true, workspace['id']]);
  });
});

describe('POST /workspaces and GET /workspaces', () => {
  it('creates a workspace (201) and lists it with my role', async () => {
    const ada = await signIn('http-ada');
    // loadDemoData: true would really seed it now (seed/seedWorkspace.test.ts covers that).
    const created = await createWorkspace(ada.token, {
      name: 'Ada Lab',
      timezone: 'Europe/London',
      loadDemoData: false,
    });
    assert.equal(created['slug'], 'ada-lab');
    assert.equal((created['settings'] as Data)['timezone'], 'Europe/London');
    assert.ok(!('deletedAt' in created));

    const list = dataOf(await api.call('GET', '/api/private/workspaces', { token: ada.token }));
    assert.deepEqual(
      (list as unknown as Data[]).map((workspace) => [
        (workspace['workspace'] as Data)['name'],
        workspace['role'],
        'areaScope' in workspace,
      ]),
      [['Ada Lab', 'owner', false]],
    );
  });

  it('answers 400 to a bad body and 409 to a taken slug', async () => {
    const bob = await signIn('http-bob');
    const post = (body: unknown): Promise<{ status: number }> =>
      api.call('POST', '/api/private/workspaces', { token: bob.token, body });
    for (const body of [
      {},
      { name: '' },
      { name: 'Workspace', extra: true },
      { name: 'Workspace', timezone: 'Mars/Olympus' },
      { name: 'Workspace', slug: 'Bad Slug!' },
      { name: 'Workspace', loadDemoData: 'yes' },
    ]) {
      assert.equal((await post(body)).status, 400, JSON.stringify(body));
    }
    await createWorkspace(bob.token, { name: 'Taken', slug: 'taken-slug' });
    assert.equal((await post({ name: 'Other', slug: 'taken-slug' })).status, 409);
  });
});

describe('PATCH /workspaces/:wid', () => {
  it('validates settings with zod: a valid IANA time zone, rules into its own topics', async () => {
    const owner = await signIn('http-patch');
    const wid = (await createWorkspace(owner.token, { name: 'Patchable' }))['id'] as string;
    const patch = (body: unknown): Promise<{ status: number; body: Data | null }> =>
      api.call('PATCH', `/api/private/workspaces/${wid}`, { token: owner.token, body });

    for (const body of [
      {},
      { settings: { timezone: 'Mars/Olympus' } },
      { settings: { timezone: '+02:00' } },
      { settings: { weekStart: 'tue' } },
      { settings: { areas: ['gym'] } },
      { settings: { topicRules: [{ match: '', topicId: 'x' }] } },
      { settings: { topicRules: [{ match: 'a/*', topicId: 'not-a-topic' }] } },
      { settings: { secret: 'x' } },
      { settings: { allowAgentPublish: 'yes' } },
      { slug: 'renamed' },
    ]) {
      assert.equal((await patch(body)).status, 400, JSON.stringify(body));
    }
    // A new workspace has its Personal topic, under its stable id.
    const { Topic } = await import('../../classes/workspace/index.js');
    const personal = Topic.defaultId(wid, 'personal');
    const ok = await patch({
      name: 'Patched',
      settings: {
        timezone: 'america/new_york',
        weekStart: 'mon',
        topicRules: [{ match: 'shalev396/*', topicId: personal }],
      },
    });
    assert.equal(ok.status, 200);
    const data = ok.body?.['data'] as Data;
    assert.equal(data['name'], 'Patched');
    assert.deepEqual(data['settings'], {
      timezone: 'America/New_York',
      weekStart: 'mon',
      topicRules: [{ match: 'shalev396/*', topicId: personal }],
      allowAgentPublish: false,
    });
    const allowed = await patch({ settings: { allowAgentPublish: true } });
    assert.equal(allowed.status, 200);
    assert.equal(
      (allowed.body?.['data'] as { settings: Data }).settings['allowAgentPublish'],
      true,
    );
  });
});

describe('the invite round trip', () => {
  it('invite (owner) → my invites → accept → member with exactly the role, of the whole workspace', async () => {
    const owner = await signIn('http-inviter');
    const classmate = await signIn('http-classmate');
    const intruder = await signIn('http-intruder');
    const wid = (await createWorkspace(owner.token, { name: 'Study group' }))['id'] as string;

    const created = await api.call('POST', `/api/private/workspaces/${wid}/invites`, {
      token: owner.token,
      body: { email: 'HTTP-Classmate@example.test', role: 'viewer' },
    });
    assert.equal(created.status, 201, created.text);
    const { invite, inviteUrl } = dataOf(created) as { invite: Data; inviteUrl: string };
    // The stage's own site (the harness runs as dev on DOMAIN_NAME=localhost).
    const match = /^https:\/\/localhost\/en\/invites\/([A-Za-z0-9_-]{43})$/.exec(inviteUrl);
    assert.ok(match, inviteUrl);
    const rawToken = match[1] ?? '';
    // The guard let it through on its own (no allowance), and only the URL carries the token.
    assert.deepEqual(findSecrets(created.body), []);
    assert.equal(created.text.split(rawToken).length - 1, 1);
    assert.deepEqual(
      [invite['email'], invite['role'], invite['status']],
      ['http-classmate@example.test', 'viewer', 'pending'],
    );

    // GET …/invites never carries a token or its hash.
    const listed = await api.call('GET', `/api/private/workspaces/${wid}/invites`, {
      token: owner.token,
    });
    assert.equal(listed.status, 200);
    assert.ok(!listed.text.includes(rawToken));
    assert.ok(!listed.text.includes(hashInviteToken(rawToken)));
    assert.ok(!listed.text.includes('tokenHash'));
    assert.deepEqual(findSecrets(listed.body), []);

    const mine = dataOf(
      await api.call('GET', '/api/private/me/invites', { token: classmate.token }),
    );
    assert.deepEqual(
      (mine as unknown as Data[]).map((p) => [p['workspaceName'], p['role'], 'areaScope' in p]),
      [['Study group', 'viewer', false]],
    );
    assert.ok(!JSON.stringify(mine).includes(rawToken));

    const accept = (token: string): Promise<{ status: number; body: Data | null }> =>
      api.call('POST', `/api/private/invites/${rawToken}/accept`, { token });
    assert.equal((await accept(intruder.token)).status, 403);
    const accepted = await accept(classmate.token);
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body?.['data'], { workspaceId: wid });
    assert.equal((await accept(classmate.token)).status, 409);

    const workspaces = dataOf(
      await api.call('GET', '/api/private/workspaces', { token: classmate.token }),
    );
    assert.deepEqual(
      (workspaces as unknown as Data[]).map((o) => [o['role'], 'areaScope' in o]),
      [['viewer', false]],
    );
    const members = dataOf(
      await api.call('GET', `/api/private/workspaces/${wid}/members`, { token: classmate.token }),
    ) as unknown as Data[];
    assert.deepEqual(
      members.map((m) => [m['email'], m['role'], 'areaScope' in m]),
      [
        ['http-inviter@example.test', 'owner', false],
        ['http-classmate@example.test', 'viewer', false],
      ],
    );
  });

  it('answers 404 to an unknown token, and 410 or 404 to an expired invite', async () => {
    const owner = await signIn('http-expiring-owner');
    const late = await signIn('http-late');
    const wid = (await createWorkspace(owner.token, { name: 'Expiring' }))['id'] as string;
    const created = dataOf(
      await api.call('POST', `/api/private/workspaces/${wid}/invites`, {
        token: owner.token,
        body: { email: late.email, role: 'editor' },
      }),
    ) as { invite: Data; inviteUrl: string };
    const rawToken = created.inviteUrl.split('/').pop() ?? '';
    const { InviteMongoModel } = await import('../../models/mongoose/Invite.js');
    await InviteMongoModel.updateOne(
      { _id: created.invite['id'] },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const accept = (token: string): Promise<{ status: number }> =>
      api.call('POST', `/api/private/invites/${token}/accept`, { token: late.token });
    // Expired invites are deleted by the Invites TTL index (DATA.md §6), whose monitor sweeps about
    // once a minute: an expired link answers 410 while the invite still exists, and 404 (like an
    // unknown token) once the sweep has removed it. Either may happen here.
    assert.ok([410, 404].includes((await accept(rawToken)).status));
    // After the sweep (done here by hand), it is always 404.
    await InviteMongoModel.deleteOne({ _id: created.invite['id'] });
    assert.equal((await accept(rawToken)).status, 404);
    assert.equal((await accept('A'.repeat(43))).status, 404);
    const members = dataOf(
      await api.call('GET', `/api/private/workspaces/${wid}/members`, { token: owner.token }),
    ) as unknown as Data[];
    assert.deepEqual(
      members.map((m) => m['email']),
      [owner.email],
    );
  });

  it('owners withdraw an invite (204), after which its link is gone (410)', async () => {
    const owner = await signIn('http-withdraw-owner');
    const guest = await signIn('http-withdrawn');
    const wid = (await createWorkspace(owner.token, { name: 'Withdrawn' }))['id'] as string;
    const created = dataOf(
      await api.call('POST', `/api/private/workspaces/${wid}/invites`, {
        token: owner.token,
        body: { email: guest.email, role: 'viewer' },
      }),
    ) as { invite: Data; inviteUrl: string };
    const revoke = await api.call(
      'DELETE',
      `/api/private/workspaces/${wid}/invites/${String(created.invite['id'])}`,
      { token: owner.token },
    );
    assert.equal(revoke.status, 204);
    const rawToken = created.inviteUrl.split('/').pop() ?? '';
    const accept = await api.call('POST', `/api/private/invites/${rawToken}/accept`, {
      token: guest.token,
    });
    assert.equal(accept.status, 410);
  });
});

describe('the join link ("anyone with the link")', () => {
  it('owner turns it on, a stranger joins with any email as viewer, and it can be reset and switched off', async () => {
    const host = await signIn('http-link-host');
    const workspace = await createWorkspace(host.token, { name: 'Link Lab' });
    const wid = workspace['id'] as string;
    const path = `/api/private/workspaces/${wid}/join-link`;

    assert.deepEqual(dataOf(await api.call('GET', path, { token: host.token })), {
      enabled: false,
      role: null,
      joinUrl: null,
    });

    const on = dataOf(
      await api.call('PUT', path, { token: host.token, body: { enabled: true, role: 'viewer' } }),
    );
    assert.equal(on['enabled'], true);
    const token = String(on['joinUrl']).split('/').pop() ?? '';
    assert.match(String(on['joinUrl']), /\/en\/join\/[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(findSecrets(JSON.stringify(on)), []);

    // A stranger with an unrelated address, and the token in the body (never in the path).
    const guest = await signIn('http-link-guest');
    const joined = await api.call('POST', '/api/private/join-links/accept', {
      token: guest.token,
      body: { token },
    });
    assert.equal(joined.status, 200, joined.text);
    assert.equal(dataOf(joined)['workspaceId'], wid);
    const mine = dataOf(
      await api.call('GET', '/api/private/workspaces', { token: guest.token }),
    ) as unknown as Data[];
    assert.equal(mine.find((m) => (m['workspace'] as Data)['id'] === wid)?.['role'], 'viewer');

    // A viewer cannot read or change the link (403).
    assert.equal((await api.call('GET', path, { token: guest.token })).status, 403);
    assert.equal(
      (await api.call('PUT', path, { token: guest.token, body: { enabled: false } })).status,
      403,
    );
    assert.equal(
      (await api.call('PUT', path, { token: host.token, body: { enabled: true, role: 'owner' } }))
        .status,
      400,
    );

    const reset = dataOf(await api.call('POST', `${path}/reset`, { token: host.token }));
    assert.notEqual(String(reset['joinUrl']).split('/').pop(), token);
    const late = await signIn('http-link-late');
    assert.equal(
      (
        await api.call('POST', '/api/private/join-links/accept', {
          token: late.token,
          body: { token },
        })
      ).status,
      404,
    );

    await api.call('PUT', path, { token: host.token, body: { enabled: false } });
    const off = await api.call('POST', '/api/private/join-links/accept', {
      token: late.token,
      body: { token: String(reset['joinUrl']).split('/').pop() },
    });
    assert.equal(off.status, 404);
  });
});

describe('invite email limits', () => {
  it('answer 429 with a plain message: the same address within 10 minutes, or one invite too many in 24 hours', async () => {
    const owner = await signIn('http-limits-owner');
    const wid = (await createWorkspace(owner.token, { name: 'Limits' }))['id'] as string;
    const send = (email: string): Promise<{ status: number; body: Data | null }> =>
      api.call('POST', `/api/private/workspaces/${wid}/invites`, {
        token: owner.token,
        body: { email, role: 'viewer' },
      });

    assert.equal((await send('twice@example.test')).status, 201);
    const again = await send('twice@example.test');
    assert.equal(again.status, 429);
    assert.deepEqual(again.body, {
      message: 'An invite was sent to this email less than 10 minutes ago. Try again later.',
      code: 'invite_rate_limited',
    });

    // The rest of the day's allowance, written straight to the ledger the limit reads.
    const { getAuditLogRepository } = await import('../../models/index.js');
    const auditLogs = await getAuditLogRepository();
    for (let i = 1; i < LIMITS.inviteEmailsPerWorkspacePerDay; i += 1) {
      await auditLogs.append(wid, {
        actorUserId: owner.id,
        action: 'member.invite',
        targetType: 'invite',
        targetId: `seeded-${String(i)}`,
        meta: { email: `seeded-${String(i)}@example.test`, role: 'viewer' },
      });
    }
    const over = await send('fresh@example.test');
    assert.equal(over.status, 429);
    assert.deepEqual(over.body, {
      message: `A workspace can send at most ${String(LIMITS.inviteEmailsPerWorkspacePerDay)} invites in 24 hours. Try again later.`,
      code: 'invite_rate_limited',
    });
  });
});

describe('PUT /me/default-workspace', () => {
  it('remembers a workspace I belong to; 404 otherwise; 400 for a bad body', async () => {
    const me = await signIn('http-switcher');
    const other = await signIn('http-switcher-other');
    const first = (await createWorkspace(me.token, { name: 'One' }))['id'] as string;
    await createWorkspace(me.token, { name: 'Two' });
    const theirs = (await createWorkspace(other.token, { name: 'Theirs' }))['id'] as string;
    const put = (body: unknown): Promise<{ status: number; body: Data | null }> =>
      api.call('PUT', '/api/private/me/default-workspace', { token: me.token, body });

    const ok = await put({ workspaceId: first });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body?.['data'], { defaultWorkspaceId: first });
    const status = dataOf(await api.call('GET', '/api/private/me', { token: me.token }));
    assert.equal(status['defaultWorkspaceId'], first);
    assert.equal((await put({ workspaceId: theirs })).status, 404);
    assert.equal((await put({})).status, 400);
  });
});

describe('deletion', () => {
  it('DELETE /workspaces/:wid (owner): 204, then it is gone for everyone', async () => {
    const owner = await signIn('http-deleter');
    const wid = (await createWorkspace(owner.token, { name: 'Short-lived' }))['id'] as string;
    const res = await api.call('DELETE', `/api/private/workspaces/${wid}`, { token: owner.token });
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
    assert.equal(
      (await api.call('GET', `/api/private/workspaces/${wid}`, { token: owner.token })).status,
      404,
    );
    const list = dataOf(await api.call('GET', '/api/private/workspaces', { token: owner.token }));
    assert.deepEqual(list, []);
  });

  it('deleting my account deletes the workspace I solely own and leaves the shared one', async () => {
    const leaving = await signIn('http-leaving');
    const host = await signIn('http-host');
    const solo = (await createWorkspace(leaving.token, { name: 'Solo' }))['id'] as string;
    const shared = (await createWorkspace(host.token, { name: 'Shared' }))['id'] as string;
    const invite = dataOf(
      await api.call('POST', `/api/private/workspaces/${shared}/invites`, {
        token: host.token,
        body: { email: leaving.email, role: 'editor' },
      }),
    ) as { inviteUrl: string };
    const rawToken = invite.inviteUrl.split('/').pop() ?? '';
    await api.call('POST', `/api/private/invites/${rawToken}/accept`, { token: leaving.token });

    const res = await api.call('DELETE', '/api/private/delete', { token: leaving.token });
    assert.equal(res.status, 200, res.text);

    const { getWorkspaceRepository } = await import('../../models/index.js');
    assert.equal(await (await getWorkspaceRepository()).findById(solo), null);
    const members = dataOf(
      await api.call('GET', `/api/private/workspaces/${shared}/members`, { token: host.token }),
    ) as unknown as Data[];
    assert.deepEqual(
      members.map((m) => m['userId']),
      [host.id],
    );
  });
});
