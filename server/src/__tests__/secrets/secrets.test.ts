/**
 * The secret-leak suite (part of `npm run test:unit`): the standing proof that no route, error path or
 * log line reveals a credential (DATA.md §0 and §7, BACKEND.md §6).
 *
 * It boots the whole app on memory Mongo, seeds FAKE secrets of every kind through the real routes,
 * then calls every registered route (the manifest), feeds every mutating route bodies and paths
 * built from those secrets, and scans every response and every line written to stdout or stderr.
 * Reports name a route, a JSON path and a kind; never a value.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startApiHarness, type ApiHarness } from '../../testing/apiHarness.js';
import { installFakeCognito } from '../../testing/fakeCognito.js';
import { findSecrets, type SecretKind } from '../../services/secretPatterns.js';
import { EXEMPT_MOUNTS, MANIFEST, type Actor, type Ctx, type Entry } from './manifest.js';
import { walkRoutes } from './routeWalk.js';
import {
  CLICKUP_CREDENTIAL,
  SERVICE_ACCOUNT_CREDENTIAL,
  GITHUB_CREDENTIAL,
  ITEM_NOTE,
  ITEM_TITLE,
  JIRA_CREDENTIAL,
  LINEAR_CREDENTIAL,
  MOODLE_CREDENTIAL,
  STATIC_SECRETS,
  type SeededValue,
} from './seed.js';
import { forceSyncModeForTests } from '../../config/testSwitches.js';

forceSyncModeForTests('fixtures');

// ─── capture of stdout and stderr (the logger, console, Express, the SDKs) ───────────────────────

let captured = '';
const originalStdout = process.stdout.write.bind(process.stdout);
const originalStderr = process.stderr.write.bind(process.stderr);

function tee(original: typeof process.stdout.write): typeof process.stdout.write {
  return (chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string') captured += chunk;
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
}

process.stdout.write = tee(originalStdout);
process.stderr.write = tee(originalStderr);

// ─── state ───────────────────────────────────────────────────────────────────────────────────────

interface Recorded {
  label: string;
  status: number;
  text: string;
}

const startedAt = Date.now();
const tokens: Partial<Record<Actor, string>> = {};
const recorded: Recorded[] = [];
/** Secrets only ever shown once, with the index of the single response allowed to carry each. */
const shownOnce: { kind: string; value: string; allowedAt: number }[] = [];
let assertions = 0;
let api: ApiHarness;
let ctx: Ctx;
let seeded: SeededValue[] = [...STATIC_SECRETS];
const sessionTokens: string[] = [];
let walkedCount = 0;
let exemptedList: string[] = [];

/** assert.* with a count, for the report. */
function check(condition: boolean, message: string): void {
  assertions += 1;
  assert.ok(condition, message);
}

/** The only answers allowed to carry a secret kind: session tokens, and a new agent key shown once. */
function allowedKinds(method: string, url: string): SecretKind[] {
  if (method !== 'POST') return [];
  if (/^\/api\/public\/auth\/(login|refresh|signup)$/.test(url)) return ['jwt'];
  if (/^\/api\/private\/workspaces\/[^/]+\/agent-keys$/.test(url)) return ['agent_key'];
  return [];
}

interface Sent {
  status: number;
  text: string;
  json: Record<string, unknown> | null;
}

/** One HTTP call. Records the answer and checks it for secret shapes straight away. */
async function send(
  actor: Actor,
  method: string,
  url: string,
  label: string,
  body?: unknown,
): Promise<Sent> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = tokens[actor];
  if (actor !== 'anon' && token !== undefined) headers['authorization'] = `Bearer ${token}`;
  const response = await fetch(`${api.baseUrl}${url}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text === '' ? null : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    json = null;
  }
  recorded.push({ label, status: response.status, text });
  const hits = findSecrets(json ?? text, { allow: allowedKinds(method, url.split('?')[0] ?? '') });
  check(
    hits.length === 0,
    `${label} answered ${String(response.status)} with a secret shape: ${hits
      .map((hit) => `${hit.path} (${hit.kind})`)
      .join(', ')}`,
  );
  check(
    response.status < 500,
    `${label} answered ${String(response.status)}: ${text.slice(0, 120)}`,
  );
  return { status: response.status, text, json };
}

function dataOf(sent: Sent): Record<string, unknown> {
  const data = sent.json?.['data'];
  assert.ok(typeof data === 'object' && data !== null, `no data in ${sent.text.slice(0, 120)}`);
  return data as Record<string, unknown>;
}

function expandPath(entry: Entry, c: Ctx, override?: string): string {
  const params: Record<string, string | undefined> = { wid: c.wid, ...entry.params?.(c) };
  return entry.path.replace(/[:*]([A-Za-z]+)/g, (_whole, name: string) =>
    encodeURIComponent(override ?? params[name] ?? name),
  );
}

const labelOf = (entry: Entry): string => `${entry.method} ${entry.path}`;

function trackDashboard(c: Ctx, sent: Sent): void {
  const data = sent.json?.['data'];
  if (
    typeof data === 'object' &&
    data !== null &&
    (data as { id?: unknown }).id === c.dashboardId
  ) {
    const version = (data as { version?: unknown }).version;
    if (typeof version === 'number') c.dashboardVersion = version;
  }
  const current = sent.json?.['currentVersion'];
  if (typeof current === 'number') c.dashboardVersion = current;
}

// ─── seeding through the real routes ─────────────────────────────────────────────────────────────

const PRIVATE = '/api/private';

async function createWorkspace(actor: Actor, name: string): Promise<string> {
  const sent = await send(actor, 'POST', `${PRIVATE}/workspaces`, 'seed: create workspace', {
    name,
  });
  assert.equal(sent.status, 201, sent.text);
  return dataOf(sent)['id'] as string;
}

async function seed(): Promise<void> {
  const models = await import('../../models/index.js');
  const users = await models.getUserRepository();
  const memberships = await models.getMembershipRepository();

  for (const [actor, email] of [
    ['owner', 'secrets-owner@example.test'],
    ['member', 'secrets-member@example.test'],
    ['throwaway', 'secrets-throwaway@example.test'],
  ] as const) {
    const login = await api.login(email);
    tokens[actor] = login.token;
    sessionTokens.push(login.token);
  }
  for (const email of ['secrets-patched@example.test', 'secrets-removed@example.test']) {
    await api.login(email);
  }

  const wid = await createWorkspace('owner', 'Secrets suite');
  const throwawayWid = await createWorkspace('throwaway', 'Throwaway');
  const idOf = async (email: string): Promise<string> => {
    const user = await users.findByEmail(email);
    assert.ok(user, `no user ${email}`);
    return user.id;
  };
  const member = await idOf('secrets-member@example.test');
  const patched = await idOf('secrets-patched@example.test');
  const removed = await idOf('secrets-removed@example.test');
  for (const userId of [member, patched, removed]) {
    await memberships.create(wid, { userId, role: 'viewer' });
  }

  const base = `${PRIVATE}/workspaces/${wid}`;
  const created = async (path: string, body: unknown, what: string): Promise<Sent> => {
    const sent = await send('owner', 'POST', `${base}${path}`, `seed: ${what}`, body);
    assert.ok(
      sent.status >= 200 && sent.status < 300,
      `${what}: ${String(sent.status)} ${sent.text}`,
    );
    return sent;
  };

  // One integration per provider, then its credential through PUT …/credential.
  const connect = async (
    body: Record<string, unknown>,
    credential: Record<string, string>,
  ): Promise<string> => {
    const integration = await created('/integrations', body, `connect ${String(body['provider'])}`);
    const iid = dataOf(integration)['id'] as string;
    const put = await send(
      'owner',
      'PUT',
      `${base}/integrations/${iid}/credential`,
      `seed: credential ${String(body['provider'])}`,
      credential,
    );
    assert.equal(put.status, 204, put.text);
    assert.equal(put.text, '', 'the credential PUT answers with no body');
    return iid;
  };
  const ownerId = await idOf('secrets-owner@example.test');
  const connectDirect = async (
    integration: {
      provider: 'moodle' | 'google_calendar';
      authMethod: 'moodle_ws_token' | 'service_account';
      accountId: string;
      config: Record<string, unknown>;
    },
    credential: Record<string, string>,
  ): Promise<string> => {
    const row = await (
      await models.getIntegrationRepository()
    ).create(wid, {
      ...integration,
      connectedBy: ownerId,
      ownerUserId: ownerId,
      label: integration.provider,
      topicId: null,
    });
    const put = await send(
      'owner',
      'PUT',
      `${base}/integrations/${row.id}/credential`,
      `seed: credential ${integration.provider}`,
      credential,
    );
    assert.equal(put.status, 204, put.text);
    return row.id;
  };
  const integrations: Ctx['integrations'] = {
    jira: await connect(
      { provider: 'jira', config: { baseUrl: 'https://secrets.atlassian.net' } },
      JIRA_CREDENTIAL,
    ),
    clickup: await connect({ provider: 'clickup', config: {} }, CLICKUP_CREDENTIAL),
    linear: await connect({ provider: 'linear', config: {} }, LINEAR_CREDENTIAL),
    // Moodle and Google Calendar (a service account, the demo's method) can't be connected over
    // REST, so these two are stored directly; their credential still goes through the route.
    moodle: await connectDirect(
      {
        provider: 'moodle',
        authMethod: 'moodle_ws_token',
        accountId: 'moodle.example.ac.il',
        config: { siteUrl: 'https://moodle.example.ac.il' },
      },
      MOODLE_CREDENTIAL,
    ),
    github: await connect(
      { provider: 'github', config: { owner: 'octo', ownerType: 'org' } },
      GITHUB_CREDENTIAL,
    ),
    gcal: await connectDirect(
      {
        provider: 'google_calendar',
        authMethod: 'service_account',
        accountId: 'gcal-service-account',
        config: { calendars: [] },
      },
      SERVICE_ACCOUNT_CREDENTIAL,
    ),
  };

  // Token-shaped text in an item: the Mongo URI with its password is in the note.
  const item = await created(
    '/items',
    { title: ITEM_TITLE, note: ITEM_NOTE },
    'item with pasted secrets',
  );
  // The same pasted secrets in a time block's note.
  const timeBlock = await created(
    '/time-blocks',
    {
      title: ITEM_TITLE,
      note: ITEM_NOTE,
      startAt: '2026-11-22T11:00:00.000Z',
      endAt: '2026-11-22T15:00:00.000Z',
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU'],
    },
    'time block with pasted secrets',
  );
  const dashboard = await created('/dashboards', { title: 'Secrets dashboard' }, 'dashboard');
  const topic = await created('/topics', { name: 'Secrets page' }, 'topic');
  const view = await created(
    '/views',
    { title: 'Secrets view', query: { source: 'items' }, viz: { kind: 'list' } },
    'view',
  );
  const invite = await created(
    '/invites',
    { email: 'secrets-invitee@example.test', role: 'viewer' },
    'invite',
  );
  const inviteData = dataOf(invite);
  const inviteUrl = inviteData['inviteUrl'] as string;
  const inviteToken = inviteUrl.slice(inviteUrl.lastIndexOf('/') + 1).split('?')[0] ?? '';
  const key = await created('/agent-keys', { name: 'Secrets key', scopes: ['read'] }, 'agent key');
  const keyData = dataOf(key);
  const rawKey = keyData['key'] as string;
  assert.match(rawKey, /^elk_/);
  shownOnce.push({ kind: 'agent_key', value: rawKey, allowedAt: recorded.length - 1 });
  shownOnce.push({ kind: 'invite_token', value: inviteToken, allowedAt: recorded.length - 2 });
  seeded = [...seeded, { kind: 'agent_key', value: rawKey }];

  ctx = {
    wid,
    throwawayWid,
    itemId: dataOf(item)['id'] as string,
    timeBlockId: dataOf(timeBlock)['id'] as string,
    dashboardId: dataOf(dashboard)['id'] as string,
    dashboardVersion: dataOf(dashboard)['version'] as number,
    viewId: dataOf(view)['id'] as string,
    topicId: (dataOf(topic)['topic'] as { id: string }).id,
    inviteId: (inviteData['invite'] as { id: string }).id,
    inviteToken,
    agentKeyId: keyData['id'] as string,
    memberIds: { patched, removed },
    integrations,
  };
}

// ─── lifecycle ───────────────────────────────────────────────────────────────────────────────────

let restoreCognito: () => void = () => undefined;

before(async () => {
  api = await startApiHarness('todolist_secret_leaks');
  // The public auth routes run the real Cognito controllers against a stand-in.
  restoreCognito = installFakeCognito();
  await seed();
});

after(async () => {
  restoreCognito();
  await api.stop();
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  originalStdout(
    `secret-leak suite: ${String(walkedCount)} routes walked, ${String(MANIFEST.length)} manifest ` +
      `entries, ${String(exemptedList.length)} exempt mounts, ${String(recorded.length)} responses ` +
      `scanned, ${String(assertions)} assertions, ${seconds} s\n`,
  );
});

// ─── the tests ───────────────────────────────────────────────────────────────────────────────────

describe('route manifest', () => {
  it('lists every registered route, and only routes that exist', async () => {
    const { createApp } = await import('../../app.js');
    const walk = walkRoutes(
      createApp(),
      MANIFEST.map((entry) => entry.path),
      EXEMPT_MOUNTS.map((mount) => mount.prefix),
    );
    check(
      walk.unresolved.length === 0,
      `mounts the manifest cannot place (add a route of theirs to manifest.ts, or exempt them): ${walk.unresolved.join('; ')}`,
    );
    walkedCount = walk.routes.length;
    exemptedList = EXEMPT_MOUNTS.map((mount) => `${mount.prefix}: ${mount.reason}`);
    const walked = new Set(walk.routes.map((route) => `${route.method} ${route.path}`));
    const listed = new Set(MANIFEST.map(labelOf));
    const missing = [...walked].filter((route) => !listed.has(route));
    const stale = [...listed].filter((route) => !walked.has(route));
    check(
      missing.length === 0,
      `routes missing from the secret-leak manifest (src/__tests__/secrets/manifest.ts): ${missing.join(', ')}`,
    );
    check(stale.length === 0, `manifest entries without a route: ${stale.join(', ')}`);
    check(
      walk.exempted.every((route) =>
        EXEMPT_MOUNTS.some((mount) => route.path.startsWith(mount.prefix)),
      ),
      'an exempt route is outside the listed exempt mounts',
    );
    check(walk.exempted.length > 0, 'the exempt mounts hold no routes: is the walk broken?');
  });
});

describe('credential route', () => {
  it('answers 204 with no body for a valid secret and a generic 400 for any bad one', async () => {
    const base = `${PRIVATE}/workspaces/${ctx.wid}/integrations`;
    const bad: unknown[] = [
      { token: GITHUB_CREDENTIAL.token, unknown: GITHUB_CREDENTIAL.projectsToken },
      { [JIRA_CREDENTIAL.token]: LINEAR_CREDENTIAL.apiKey },
      { apiKey: { nested: SERVICE_ACCOUNT_CREDENTIAL.privateKey } },
      [JIRA_CREDENTIAL.token],
      JIRA_CREDENTIAL.token,
      {
        clientEmail: SERVICE_ACCOUNT_CREDENTIAL.clientEmail,
        privateKey: 7,
        kid: [CLICKUP_CREDENTIAL.token],
      },
    ];
    for (const [provider, iid] of Object.entries(ctx.integrations)) {
      for (const body of bad) {
        const sent = await send(
          'owner',
          'PUT',
          `${base}/${iid}/credential`,
          'PUT /api/private/workspaces/:wid/integrations/:iid/credential',
          body,
        );
        check(sent.status === 400, `${provider}: a bad secret answered ${String(sent.status)}`);
        check(typeof sent.json?.['message'] === 'string', `${provider}: the 400 has a message`);
      }
    }
    const good = await send(
      'owner',
      'PUT',
      `${base}/${ctx.integrations.linear}/credential`,
      'PUT /api/private/workspaces/:wid/integrations/:iid/credential',
      LINEAR_CREDENTIAL,
    );
    check(good.status === 204 && good.text === '', 'a valid secret answers 204 with no body');
  });

  it('integration status carries exactly the six keys', async () => {
    const sent = await send(
      'owner',
      'GET',
      `${PRIVATE}/workspaces/${ctx.wid}/integrations`,
      'GET /api/private/workspaces/:wid/integrations',
    );
    const list = sent.json?.['data'] as Record<string, unknown>[];
    check(list.length === 6, `six integrations listed, got ${String(list.length)}`);
    for (const status of list) {
      assert.deepEqual(Object.keys(status).sort(), [
        'accountLabel',
        'authMethod',
        'canSwitchMode',
        'expiresAt',
        'id',
        'lastSyncAt',
        'mode',
        'needsReconnect',
        'provider',
        // A Google Calendar's live pushed events (a count), and only there.
        ...(status['provider'] === 'google_calendar' ? ['pushedEvents'] : []),
        'status',
        'topicId',
      ]);
      if (status['provider'] === 'google_calendar') {
        check(typeof status['pushedEvents'] === 'number', 'pushedEvents is a count');
      }
      assertions += 1;
    }
  });
});

/** Every field name a body schema of this API reads; a secret goes into each. */
const FIELDS = [
  'name',
  'title',
  'note',
  'email',
  'role',
  'slug',
  'label',
  'topicId',
  'link',
  'provider',
  'config',
  'token',
  'apiKey',
  'secret',
  'password',
  'code',
  'refreshToken',
  'workspaceId',
  'templateKey',
  'draft',
  'query',
  'viz',
  'layouts',
  'ops',
  'scopes',
  'settings',
  'integrationId',
  'toVersion',
  'expectedVersion',
  'purpose',
  'fileName',
  'mimeType',
  'idempotencyKey',
  'done',
  'pinned',
  'source',
  'dashboardId',
  'blockId',
];

function allSecrets(): string {
  return seeded.map((entry) => entry.value).join(' ');
}

function badBodies(): unknown[] {
  const text = allSecrets();
  const flat = Object.fromEntries(FIELDS.map((field) => [field, text]));
  const nested = Object.fromEntries(
    FIELDS.map((field) => [field, { value: text, [text]: [text, { [text]: text }] }]),
  );
  return [{ ...flat, [text]: text }, nested, [text]];
}

describe('bad paths and bad inputs', () => {
  it('a secret in every path parameter is never echoed', async () => {
    const secret = JIRA_CREDENTIAL.token;
    let calls = 0;
    for (const entry of MANIFEST) {
      if (!/[:*][A-Za-z]/.test(entry.path)) continue;
      const url = expandPath(entry, ctx, secret);
      const sent = await send(
        entry.as ?? 'owner',
        entry.method,
        url,
        labelOf(entry),
        entry.method === 'GET' || entry.method === 'DELETE' ? undefined : {},
      );
      check(
        sent.status >= 400 || entry.method === 'GET',
        `${labelOf(entry)}: a bad id answered ${String(sent.status)}`,
      );
      calls += 1;
    }
    check(calls > 40, `only ${String(calls)} parameterised routes were called`);
  });

  it('a secret in an invalid body field is never echoed, on every POST, PATCH and PUT', async () => {
    let calls = 0;
    for (const entry of MANIFEST) {
      if (entry.method === 'GET' || entry.method === 'DELETE' || entry.noBadInput === true)
        continue;
      for (const body of badBodies()) {
        // Reaching a validator needs the real ids; the body is the only thing made up.
        await send(entry.as ?? 'owner', entry.method, expandPath(entry, ctx), labelOf(entry), body);
        calls += 1;
      }
    }
    check(calls > 100, `only ${String(calls)} bad-input calls were made`);
  });
});

describe('manifest pass', () => {
  it('every route answers within its expected status class, with no secret in the answer', async () => {
    for (const entry of MANIFEST) {
      const body = entry.body?.(ctx);
      const query = entry.query === undefined ? '' : `?${entry.query}`;
      const sent = await send(
        entry.as ?? 'owner',
        entry.method,
        `${expandPath(entry, ctx)}${query}`,
        labelOf(entry),
        body,
      );
      trackDashboard(ctx, sent);
      const klass = Math.floor(sent.status / 100);
      check(
        entry.expect.some((expected) => expected === klass),
        `${labelOf(entry)} answered ${String(sent.status)}: ${sent.text.slice(0, 160)}`,
      );
      if (labelOf(entry) === 'POST /api/private/workspaces/:wid/agent-keys' && klass === 2) {
        const raw = (sent.json?.['data'] as { key?: unknown } | undefined)?.key;
        check(typeof raw === 'string', 'the agent-key creation shows the key');
        shownOnce.push({ kind: 'agent_key', value: String(raw), allowedAt: recorded.length - 1 });
        seeded = [...seeded, { kind: 'agent_key', value: String(raw) }];
      }
    }
  });
});

describe('what was seen', () => {
  it('no response holds a seeded secret, and a raw agent key only its creation answer', () => {
    for (const secret of seeded) {
      const at = shownOnce.find((once) => once.value === secret.value)?.allowedAt;
      recorded.forEach((response, index) => {
        if (index === at) return;
        check(
          !response.text.includes(secret.value),
          `${response.label} (${String(response.status)}) returned a seeded ${secret.kind}`,
        );
      });
    }
    for (const once of shownOnce) {
      check(
        recorded[once.allowedAt]?.text.includes(once.value) === true ||
          once.kind === 'invite_token',
        `the ${once.kind} is not in the one answer that may show it`,
      );
    }
  });

  it('no session token comes back outside login, refresh and signup', () => {
    for (const token of sessionTokens) {
      recorded.forEach((response) => {
        if (/auth\/(login|refresh|signup)/.test(response.label)) return;
        check(!response.text.includes(token), `${response.label} returned a session token`);
      });
    }
  });

  it('the database holds no plaintext secret and no credential envelope leaves the vault', async () => {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;
    assert.ok(db, 'no database connection');
    const collections = (await db.listCollections().toArray()).map((entry) => entry.name);
    let text = '';
    for (const name of collections) {
      // An item's title and note are the user's own text, kept as typed and redacted on the way out.
      if (/^items?$/i.test(name)) continue;
      text += JSON.stringify(await db.collection(name).find({}).toArray());
    }
    for (const secret of seeded) {
      if (secret.kind === 'agent_key') {
        check(
          !text.includes(secret.value),
          'the database holds a raw agent key (only its hash may be stored)',
        );
        continue;
      }
      check(!text.includes(secret.value), `the database holds a plaintext ${secret.kind}`);
    }

    const { CredentialMongoModel } = await import('../../models/mongoose/Credential.js');
    const documents = await CredentialMongoModel.find({}).select('+enc');
    check(
      documents.length >= 5,
      `expected the sealed credentials, found ${String(documents.length)}`,
    );
    for (const document of documents) {
      check(
        !JSON.stringify(document).includes('"enc"') &&
          !JSON.stringify(document.toObject()).includes('"enc"'),
        'a Credential document serialises its envelope',
      );
    }
    const credentials = await (await import('../../models/index.js')).getCredentialRepository();
    for (const iid of Object.values(ctx.integrations)) {
      const meta = await credentials.findMeta(ctx.wid, iid);
      if (meta === null) continue;
      check(!JSON.stringify(meta).includes('enc'), 'credential metadata carries the envelope');
    }
  });

  it('no log line holds a secret shape or a seeded raw value', async () => {
    // Let background work (sync runs the manifest started) write what it is going to write.
    await new Promise((resolve) => setTimeout(resolve, 750));
    check(captured.length > 0, 'nothing was captured: is the capture broken?');
    const hits = findSecrets(captured).map((hit) => hit.kind);
    check(hits.length === 0, `the logs hold secret shapes: ${[...new Set(hits)].join(', ')}`);
    for (const secret of seeded) {
      check(!captured.includes(secret.value), `the logs hold a seeded ${secret.kind}`);
    }
    for (const token of sessionTokens) {
      check(!captured.includes(token), 'the logs hold a session token');
    }
  });
});
