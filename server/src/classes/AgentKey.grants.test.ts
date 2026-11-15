/** AgentKey grants: OAuth access/refresh tokens, rotation with a grace window, reuse detection. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { newTeam } from '../mcp/__tests__/helpers/team.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import { callerFor } from '../testing/workspaceFixtures.js';
import { AuditLog } from './AuditLog.js';
import type { AgentKey as AgentKeyClass, IssuedTokens } from './AgentKey.js';
import { Actor } from './base/Actor.js';
import type { OAuthError as OAuthErrorClass } from '../errors/OAuthError.js';
import type { getAgentKeyRepository as GetRepo } from '../models/index.js';

let db: TestDatabase;
let AgentKey: typeof AgentKeyClass;
let OAuthError: typeof OAuthErrorClass;
let getAgentKeyRepository: typeof GetRepo;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CLIENT = 'client-a';

before(async () => {
  db = await startTestDatabase('todolist_agent_key_grants_test');
  const { syncDB } = await import('../config/database.js');
  await syncDB();
  ({ AgentKey } = await import('./AgentKey.js'));
  ({ OAuthError } = await import('../errors/OAuthError.js'));
  ({ getAgentKeyRepository } = await import('../models/index.js'));
});

after(async () => {
  await db.stop();
});

type Team = Awaited<ReturnType<typeof newTeam>>;

let requestCounter = 0;

async function grant(
  label: string,
  clientId = CLIENT,
): Promise<{ team: Team; tokens: IssuedTokens }> {
  const team = await newTeam(`grants-${label}`);
  return { team, tokens: await issue(team, clientId) };
}

function issue(team: Team, clientId = CLIENT, now?: Date): Promise<IssuedTokens> {
  return issueWithSource(team, clientId, now).then((issued) => issued.tokens);
}

async function issueWithSource(
  team: Team,
  clientId = CLIENT,
  now?: Date,
): Promise<{ source: string; tokens: IssuedTokens }> {
  requestCounter += 1;
  const source = `req-${String(requestCounter)}-${label()}`;
  const tokens = await AgentKey.issueGrant(
    {
      workspaceId: team.workspace.id,
      userId: team.editor.id,
      name: 'Claude',
      scopes: ['read', 'items:write'],
      clientId,
      clientName: 'Claude Desktop',
      resource: 'https://example.test/mcp',
      sourceRequestId: source,
    },
    Actor.user(team.editor.id),
    now,
  );
  return { source, tokens };
}

function label(): string {
  return Math.random().toString(36).slice(2);
}

async function assertInvalidGrant(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof OAuthError);
    assert.equal(error.oauthCode, 'invalid_grant');
    assert.equal(error.statusCode, 400);
    return true;
  });
}

describe('AgentKey grants', () => {
  it('an issued access token authenticates for an hour, then not', async () => {
    const { tokens } = await grant('hour');
    const t0 = new Date();
    assert.equal(tokens.expiresIn, 3600);
    assert.equal(tokens.scope, 'read items:write');
    assert.match(tokens.accessToken, /^elo_[A-Za-z0-9_-]{43}$/);
    assert.match(tokens.refreshToken, /^elr_[A-Za-z0-9_-]{43}$/);
    const agent = await AgentKey.authenticate(
      tokens.accessToken,
      new Date(t0.getTime() + 59 * MIN),
      {},
    );
    assert.ok(agent);
    assert.equal(agent.resource, 'https://example.test/mcp');
    assert.equal(
      await AgentKey.authenticate(tokens.accessToken, new Date(t0.getTime() + 61 * MIN), {}),
      null,
    );
    // A refresh token is not a bearer credential.
    assert.equal(await AgentKey.authenticate(tokens.refreshToken, t0, {}), null);
  });

  it('a plain key has no resource', async () => {
    const team = await newTeam('grants-plainkey');
    const caller = await callerFor(team.workspace.id, team.editor.id);
    const { raw } = await AgentKey.create(caller, { name: 'k', scopes: ['read'] });
    const agent = await AgentKey.authenticate(raw, new Date(), {});
    assert.ok(agent);
    assert.equal(agent.resource, null);
  });

  it('refresh rotates both tokens; the old access token stops working', async () => {
    const { tokens } = await grant('rotate');
    const t0 = new Date();
    const next = await AgentKey.refresh(tokens.refreshToken, CLIENT, new Date(t0.getTime() + MIN));
    assert.notEqual(next.accessToken, tokens.accessToken);
    assert.notEqual(next.refreshToken, tokens.refreshToken);
    assert.equal(next.expiresIn, 3600);
    assert.equal(await AgentKey.authenticate(tokens.accessToken, t0, {}), null);
    assert.ok(await AgentKey.authenticate(next.accessToken, new Date(t0.getTime() + 2 * MIN), {}));
  });

  it('a refresh retried within 30 seconds rotates again; after 31 seconds it revokes the grant', async () => {
    const { tokens } = await grant('grace');
    const t0 = new Date();
    const first = await AgentKey.refresh(tokens.refreshToken, CLIENT, t0);
    const retry = await AgentKey.refresh(
      tokens.refreshToken,
      CLIENT,
      new Date(t0.getTime() + 29_000),
    );
    assert.notEqual(retry.refreshToken, first.refreshToken);
    // The grant stays usable through the retry's tokens.
    assert.ok(await AgentKey.authenticate(retry.accessToken, new Date(t0.getTime() + 30_000), {}));

    // A second grant: the old refresh token shown 31 seconds after it was rotated away.
    const second = await grant('grace-late');
    const issued = new Date();
    const rotated = await AgentKey.refresh(second.tokens.refreshToken, CLIENT, issued);
    await assertInvalidGrant(
      AgentKey.refresh(second.tokens.refreshToken, CLIENT, new Date(issued.getTime() + 31_000)),
    );
    const later = new Date(issued.getTime() + 32_000);
    assert.equal(await AgentKey.authenticate(rotated.accessToken, later, {}), null);
    await assertInvalidGrant(AgentKey.refresh(rotated.refreshToken, CLIENT, later));
  });

  it('a refresh token unused for 90 days is refused; the 365-day cap holds even when used daily', async () => {
    const unused = await grant('idle');
    const t0 = new Date();
    await assertInvalidGrant(
      AgentKey.refresh(unused.tokens.refreshToken, CLIENT, new Date(t0.getTime() + 91 * DAY)),
    );

    const { tokens } = await grant('cap');
    let refresh = tokens.refreshToken;
    for (let day = 1; day < 365; day += 1) {
      refresh = (await AgentKey.refresh(refresh, CLIENT, new Date(t0.getTime() + day * DAY)))
        .refreshToken;
    }
    await assertInvalidGrant(AgentKey.refresh(refresh, CLIENT, new Date(t0.getTime() + 366 * DAY)));
  });

  it('two grants from the same user and client live side by side', async () => {
    const team = await newTeam('grants-twins');
    const a = await issue(team);
    const b = await issue(team);
    const t0 = new Date();
    await AgentKey.refresh(a.refreshToken, CLIENT, t0);
    assert.ok(await AgentKey.authenticate(b.accessToken, t0, {}));
    assert.equal(await AgentKey.authenticate(a.accessToken, t0, {}), null);
  });

  it('revokeForUser ends grants too', async () => {
    const { team, tokens } = await grant('user-revoke');
    const keys = await getAgentKeyRepository();
    assert.ok((await keys.revokeForUser(team.workspace.id, team.editor.id)) >= 1);
    const now = new Date();
    assert.equal(await AgentKey.authenticate(tokens.accessToken, now, {}), null);
    await assertInvalidGrant(AgentKey.refresh(tokens.refreshToken, CLIENT, now));
  });

  it('the cap counts usable keys and grants together', async () => {
    const team = await newTeam('grants-cap');
    const caller = await callerFor(team.workspace.id, team.editor.id);
    const keys = await getAgentKeyRepository();
    const cap = 10;
    const created = [];
    for (let i = 0; i < cap - 1; i += 1) {
      created.push(await AgentKey.create(caller, { name: `k${String(i)}`, scopes: ['read'] }));
    }
    await issue(team);
    assert.equal(await keys.countForUser(team.workspace.id, team.editor.id), cap);
    await assert.rejects(
      AgentKey.create(caller, { name: 'one too many', scopes: ['read'] }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
    );
    const first = created[0];
    assert.ok(first);
    await AgentKey.revoke(caller, first.key.id);
    await AgentKey.create(caller, { name: 'fits now', scopes: ['read'] });
  });

  it('a refresh with another clientId is invalid_grant', async () => {
    const { tokens } = await grant('other-client');
    await assertInvalidGrant(AgentKey.refresh(tokens.refreshToken, 'client-b'));
    // The mismatch changed nothing: the right client still refreshes.
    await AgentKey.refresh(tokens.refreshToken, CLIENT);
  });

  it('an unknown or malformed refresh token is invalid_grant', async () => {
    await assertInvalidGrant(AgentKey.refresh('elr_' + 'A'.repeat(43), CLIENT));
    await assertInvalidGrant(AgentKey.refresh('nonsense', CLIENT));
  });

  it('revokeByToken ends a grant by either token; another client or an unknown token is a no-op', async () => {
    const team = await newTeam('grants-revoke-token');
    const byRefresh = await issue(team);
    await AgentKey.revokeByToken(byRefresh.accessToken, 'client-b');
    assert.ok(await AgentKey.authenticate(byRefresh.accessToken, new Date(), {}));
    await AgentKey.revokeByToken(byRefresh.refreshToken, CLIENT);
    assert.equal(await AgentKey.authenticate(byRefresh.accessToken, new Date(), {}), null);
    await assertInvalidGrant(AgentKey.refresh(byRefresh.refreshToken, CLIENT));

    const byAccess = await issue(team);
    await AgentKey.revokeByToken(byAccess.accessToken, CLIENT);
    assert.equal(await AgentKey.authenticate(byAccess.accessToken, new Date(), {}), null);

    await AgentKey.revokeByToken('elr_' + 'B'.repeat(43), CLIENT);
    await AgentKey.revokeByToken('garbage', CLIENT);
  });

  it('revokeBySource ends the grant its authorization request made', async () => {
    const team = await newTeam('grants-revoke-source');
    const { source, tokens } = await issueWithSource(team);
    await AgentKey.revokeBySource('unknown-request');
    assert.ok(await AgentKey.authenticate(tokens.accessToken, new Date(), {}));
    await AgentKey.revokeBySource(source);
    assert.equal(await AgentKey.authenticate(tokens.accessToken, new Date(), {}), null);
    await AgentKey.revokeBySource(source); // again: a no-op
  });

  it('audits the grant, a refresh at most hourly, and a reuse, never a token', async () => {
    const team = await newTeam('grants-audit');
    const tokens = await issue(team);
    const t0 = new Date();
    const first = await AgentKey.refresh(tokens.refreshToken, CLIENT, t0);
    const second = await AgentKey.refresh(
      first.refreshToken,
      CLIENT,
      new Date(t0.getTime() + 10 * MIN),
    );
    const third = await AgentKey.refresh(
      second.refreshToken,
      CLIENT,
      new Date(t0.getTime() + 61 * MIN),
    );
    await assertInvalidGrant(
      AgentKey.refresh(second.refreshToken, CLIENT, new Date(t0.getTime() + 62 * MIN)),
    );
    const entries = await AuditLog.list(team.workspace.id, {}, 50);
    const count = (action: string): number => entries.filter((e) => e.action === action).length;
    assert.equal(count('agent_key.oauth_grant'), 1);
    assert.equal(count('agent_key.oauth_refresh'), 2);
    assert.equal(count('agent_key.oauth_reuse'), 1);
    const text = JSON.stringify(entries.map((e) => e.meta));
    for (const token of [tokens, first, second, third]) {
      assert.ok(!text.includes(token.accessToken) && !text.includes(token.refreshToken));
    }
    assert.doesNotMatch(text, /el[kor]_|hash/i);
  });

  it('list shows a grant with kind oauth and its client name, never a hash', async () => {
    const team = await newTeam('grants-list');
    await issue(team);
    const owner = await callerFor(team.workspace.id, team.owner.id);
    const views = await AgentKey.list(owner);
    const view = views.find((v) => v.kind === 'oauth');
    assert.ok(view);
    assert.equal(view.clientName, 'Claude Desktop');
    assert.doesNotMatch(JSON.stringify(views), /hash/i);
    assert.doesNotMatch(JSON.stringify(views), /el[kor]_[A-Za-z0-9_-]{16,}/);
  });
});
