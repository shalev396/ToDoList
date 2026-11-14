import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hasStatus } from '../../testing/workspaceFixtures.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type * as Models from '../../models/index.js';
import type { IntegrationData } from '../../models/index.js';
import type * as Vault from './credentialVault.js';
import type * as Writer from './credentialWriter.js';

const JIRA_SECRET = { email: 'dev@example.test', token: 'ATATT3xFAKEjiraTokenFAKE0123456789' };
/** A second real secret beside the token: `email` is an identity field, a label (IDENTITY_FIELDS). */
const JIRA_SECRET_WITH_PROJECTS = {
  ...JIRA_SECRET,
  projectsToken: 'FAKE-projects-token-0123456789abcd',
};
const LABELLED_SECRET = {
  token: 'FAKE-token-0123456789abcdefghijklmnop',
  kid: 'k1',
};

let db: TestDatabase;
let vault: typeof Vault;
let writer: typeof Writer;
let models: typeof Models;
let accounts = 0;

before(async () => {
  db = await startTestDatabase('todolist_vault_test');
  vault = await import('./credentialVault.js');
  writer = await import('./credentialWriter.js');
  models = await import('../../models/index.js');
});

after(async () => {
  await db.stop();
});

async function newIntegration(
  workspaceId: string,
  provider: 'jira' | 'google_calendar' = 'jira',
): Promise<IntegrationData> {
  accounts += 1;
  return (await models.getIntegrationRepository()).create(workspaceId, {
    connectedBy: 'u-owner',
    provider,
    accountId: `account-${String(accounts)}.example.invalid`,
    label: `${provider} ${String(accounts)}`,
    authMethod: provider === 'jira' ? 'api_token_basic' : 'service_account',
    topicId: 'work',
  });
}

async function store(
  integration: IntegrationData,
  secret: Record<string, string>,
  extra: Partial<Writer.StoreCredentialInput> = {},
): Promise<void> {
  await writer.storeCredential({
    workspaceId: integration.workspaceId,
    integrationId: integration.id,
    provider: integration.provider,
    ownerUserId: 'u-owner',
    kind: 'api_token',
    secret,
    ...extra,
  });
}

async function meta(integration: IntegrationData): Promise<Models.CredentialData | null> {
  return (await models.getCredentialRepository()).findMeta(integration.workspaceId, integration.id);
}

/** How `run` settles, and what the logger wrote to stderr meanwhile (captured, not printed). */
async function withStderr<T>(
  run: () => Promise<T>,
): Promise<{ outcome: PromiseSettledResult<T>; stderr: string }> {
  const chunks: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  try {
    const [outcome] = await Promise.allSettled([run()]);
    return { outcome: outcome as PromiseSettledResult<T>, stderr: chunks.join('') };
  } finally {
    process.stderr.write = write;
  }
}

function rejection<T>(outcome: PromiseSettledResult<T>): unknown {
  assert.equal(outcome.status, 'rejected', 'expected a rejection');
  return outcome.reason;
}

describe('credentialWriter → credentialVault', () => {
  it('round-trips: sealed at rest, linked to its integration, opened only by the vault', async () => {
    const integration = await newIntegration('w-vault');
    const expiresAt = new Date('2027-11-01T00:00:00Z');
    await store(integration, JIRA_SECRET, { scopes: ['read:jira-work'], expiresAt });

    const stored = await meta(integration);
    assert.ok(stored);
    assert.deepEqual(
      [stored.kind, stored.scopes, stored.expiresAt, stored.rotatedAt],
      ['api_token', ['read:jira-work'], expiresAt, null],
    );
    const linked = await (
      await models.getIntegrationRepository()
    ).findById('w-vault', integration.id);
    assert.equal(linked?.credentialId, stored.id);

    const { CredentialMongoModel } = await import('../../models/mongoose/Credential.js');
    const raw = await CredentialMongoModel.findOne({ integrationId: integration.id })
      .select('+enc')
      .lean();
    assert.ok(raw);
    assert.equal(raw.enc.keyProvider, 'aws-kms');
    assert.equal(raw.enc.aad, `w-vault|${integration.id}|jira`);
    assert.ok(!JSON.stringify(raw).includes(JIRA_SECRET.token));

    let seen: Record<string, string> | null = null;
    const result = await vault.decryptForSync(integration.id, async (secret) => {
      seen = { ...secret };
      return Promise.resolve('fn result');
    });
    assert.equal(result, 'fn result');
    assert.deepEqual(seen, JIRA_SECRET);
    assert.ok((await meta(integration))?.lastUsedAt instanceof Date);
  });

  it('replacing a token seals it again and sets rotatedAt', async () => {
    const integration = await newIntegration('w-vault');
    await store(integration, JIRA_SECRET);
    const first = await meta(integration);
    await store(integration, { ...JIRA_SECRET, token: 'ATATT3xFAKErotatedTokenFAKE987654' });
    const second = await meta(integration);
    assert.equal(second?.id, first?.id);
    assert.ok(second?.rotatedAt instanceof Date);
    // Compared inside fn: the vault refuses a result that carries the token itself.
    const rotated = await vault.decryptForSync(integration.id, (secret) =>
      Promise.resolve(secret['token'] === 'ATATT3xFAKErotatedTokenFAKE987654'),
    );
    assert.equal(rotated, true);
  });

  it('fn gets a frozen secret; the vault returns fn’s result and nothing else', async () => {
    const integration = await newIntegration('w-vault');
    await store(integration, JIRA_SECRET);
    const marker = { ok: true };
    const result = await vault.decryptForSync(integration.id, (secret) => {
      assert.ok(Object.isFrozen(secret));
      assert.throws(() => {
        (secret as Record<string, string>)['token'] = 'changed';
      });
      return Promise.resolve(marker);
    });
    assert.equal(result, marker);

    // fn's failure comes back as is, and the use is still recorded.
    await (
      await models.getCredentialRepository()
    ).touch(integration.workspaceId, integration.id, new Date(0));
    await assert.rejects(
      vault.decryptForSync(integration.id, () => Promise.reject(new Error('provider said 401'))),
      /provider said 401/,
    );
    assert.ok(((await meta(integration))?.lastUsedAt?.getTime() ?? 0) > 0);
  });

  it('a ciphertext copied to another integration or workspace does not decrypt', async () => {
    const source = await newIntegration('w-vault');
    await store(source, JIRA_SECRET);
    const repo = await models.getCredentialRepository();
    const sealed = await repo.findSealed(source.workspaceId, source.id);
    assert.ok(sealed);

    const sameWorkspace = await newIntegration('w-vault');
    const otherWorkspace = await newIntegration('w-vault-other');
    for (const target of [sameWorkspace, otherWorkspace]) {
      for (const enc of [
        sealed.enc,
        // Even with the stored AAD rewritten to match the target, GCM still binds the original.
        { ...sealed.enc, aad: `${target.workspaceId}|${target.id}|jira` },
      ]) {
        await repo.upsertSealed(target.workspaceId, target.id, {
          ownerUserId: 'u-owner',
          kind: 'api_token',
          enc,
        });
        let called = false;
        await assert.rejects(
          vault.decryptForSync(target.id, () => {
            called = true;
            return Promise.resolve(null);
          }),
        );
        assert.equal(called, false);
      }
    }
  });

  it('the door answers 404 when the integration or its credential is missing', async () => {
    const bare = await newIntegration('w-vault');
    const gone = await newIntegration('w-vault');
    await store(gone, JIRA_SECRET);
    await (await models.getIntegrationRepository()).softDelete('w-vault', gone.id);
    for (const integrationId of ['no-such-integration', bare.id, gone.id]) {
      await assert.rejects(
        vault.decryptForSync(integrationId, () => Promise.resolve(null)),
        hasStatus(404),
      );
    }
  });

  it('decryptForSync(id, s => s) throws: a result that carries a secret value is refused (500), and only the reason is logged', async () => {
    const integration = await newIntegration('w-vault');
    await store(integration, JIRA_SECRET_WITH_PROJECTS);
    const { outcome, stderr } = await withStderr(() =>
      vault.decryptForSync(integration.id, (secret) => Promise.resolve(secret)),
    );
    assert.ok(hasStatus(500)(rejection(outcome)));
    assert.match(stderr, /vault_result_leak/);
    assert.ok(stderr.includes(integration.id));
    for (const value of [JIRA_SECRET.token, JIRA_SECRET_WITH_PROJECTS.projectsToken]) {
      assert.ok(!stderr.includes(value));
    }

    // The secret inside something else is refused too.
    const smuggled: ((secret: Vault.SecretJson) => unknown)[] = [
      (secret): unknown => ({ headers: [`Basic token=${secret['token'] ?? ''}`] }),
      (secret): unknown => new Map([['projects', secret['projectsToken']]]),
      (secret): unknown => Buffer.from(secret['token'] ?? ''),
    ];
    for (const smuggle of smuggled) {
      const settled = await withStderr(() =>
        vault.decryptForSync(integration.id, (secret) => Promise.resolve(smuggle(secret))),
      );
      assert.ok(hasStatus(500)(rejection(settled.outcome)));
    }
  });

  it('an account label is not a secret: {accountLabel: <the Jira email>} comes back unchanged', async () => {
    const integration = await newIntegration('w-vault');
    await store(integration, JIRA_SECRET);
    const result = await vault.decryptForSync(integration.id, (secret) =>
      Promise.resolve({ accountLabel: secret['email'] }),
    );
    assert.deepEqual(result, { accountLabel: JIRA_SECRET.email });
  });

  it('the same call that also returns the token is still refused (500)', async () => {
    const integration = await newIntegration('w-vault');
    await store(integration, JIRA_SECRET);
    const { outcome } = await withStderr(() =>
      vault.decryptForSync(integration.id, (secret) =>
        Promise.resolve({ accountLabel: secret['email'], token: secret['token'] }),
      ),
    );
    assert.ok(hasStatus(500)(rejection(outcome)));
  });

  it('a normal result passes, the key id (a label) included', async () => {
    const integration = await newIntegration('w-vault', 'google_calendar');
    await store(integration, LABELLED_SECRET);
    const result = await vault.decryptForSync(integration.id, (secret) =>
      Promise.resolve({ ok: true, kid: secret['kid'], pushed: 3, at: new Date(0) }),
    );
    assert.deepEqual(result, { ok: true, kid: 'k1', pushed: 3, at: new Date(0) });
  });

  it('an error that carries the token comes out redacted, with its class, name and code', async () => {
    const integration = await newIntegration('w-vault');
    await store(integration, JIRA_SECRET_WITH_PROJECTS);
    class ProviderFailure extends Error {
      readonly code = 'auth_failed';
      constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'ProviderFailure';
      }
    }
    // The account email is a label and stays; the token and the projects token are redacted.
    const thrown = new ProviderFailure(
      `401 for ${JIRA_SECRET.email} with token ${JIRA_SECRET.token}`,
      { cause: new Error(`upstream rejected ${JIRA_SECRET_WITH_PROJECTS.projectsToken}`) },
    );
    const error = rejection(
      (await withStderr(() => vault.decryptForSync(integration.id, () => Promise.reject(thrown))))
        .outcome,
    );
    assert.ok(error instanceof ProviderFailure);
    assert.deepEqual(
      [error.name, error.code, error.message, (error.cause as Error).message],
      [
        'ProviderFailure',
        'auth_failed',
        `401 for ${JIRA_SECRET.email} with token [REDACTED]`,
        'upstream rejected [REDACTED]',
      ],
    );
    assert.ok(!String(error.stack).includes(JIRA_SECRET.token));

    // What the sync engine classifies by class comes through as the same object.
    const { ProviderHttpError } = await import('../../sync/errors.js');
    const providerError = new ProviderHttpError('jira', 401, 'auth_failed');
    await assert.rejects(
      vault.decryptForSync(integration.id, () => Promise.reject(providerError)),
      (rejected: unknown) => rejected === providerError,
    );
  });

  it('a credential that cannot be opened: callers get a generic message, the log names the error', async () => {
    const throttled = await newIntegration('w-vault');
    await store(throttled, JIRA_SECRET);
    const { stageKeyProvider } = await import('./stageKeyProvider.js');
    const keyProvider = stageKeyProvider();
    const decryptDataKey = Object.getOwnPropertyDescriptor(keyProvider, 'decryptDataKey');
    Object.defineProperty(keyProvider, 'decryptDataKey', {
      value: () =>
        Promise.reject(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })),
      configurable: true,
    });
    let throttling: Awaited<ReturnType<typeof withStderr>>;
    try {
      throttling = await withStderr(() =>
        vault.decryptForSync(throttled.id, () => Promise.resolve('unreachable')),
      );
    } finally {
      Object.defineProperty(keyProvider, 'decryptDataKey', decryptDataKey ?? {});
    }

    // A ciphertext copied to another integration fails its AAD check instead.
    const repo = await models.getCredentialRepository();
    const sealed = await repo.findSealed(throttled.workspaceId, throttled.id);
    assert.ok(sealed);
    const misplaced = await newIntegration('w-vault');
    await repo.upsertSealed(misplaced.workspaceId, misplaced.id, {
      ownerUserId: 'u-owner',
      kind: 'api_token',
      enc: sealed.enc,
    });
    const tampering = await withStderr(() =>
      vault.decryptForSync(misplaced.id, () => Promise.resolve('unreachable')),
    );

    for (const [{ outcome, stderr }, integrationId, errorName] of [
      [throttling, throttled.id, 'ThrottlingException'],
      [tampering, misplaced.id, 'Error'],
    ] as const) {
      const error = rejection(outcome);
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'The credential could not be decrypted');
      assert.ok(stderr.includes(integrationId));
      assert.ok(stderr.includes(`errorName: '${errorName}'`), stderr);
    }
    assert.ok(!throttling.stderr.includes('Rate exceeded'));
  });

  it('storeCredential audits integration.connect, then credential.rotate on a replace: owner, integration, no secret data', async () => {
    const integration = await newIntegration('w-audit');
    const rotatedToken = 'ATATT3xFAKErotatedAuditTokenFAKE4242';
    await store(integration, JIRA_SECRET_WITH_PROJECTS, { ownerUserId: 'u-connector' });
    await store(
      integration,
      { ...JIRA_SECRET_WITH_PROJECTS, token: rotatedToken },
      { ownerUserId: 'u-rotator' },
    );

    const credential = await meta(integration);
    assert.ok(credential);
    const entries = (await (await models.getAuditLogRepository()).list('w-audit', {}, 10)).filter(
      (entry) => entry.targetId === integration.id,
    );
    const expected = { credentialId: credential.id, provider: 'jira', kind: 'api_token' };
    assert.equal(entries.length, 2);
    for (const [action, actor] of [
      ['integration.connect', 'u-connector'],
      ['credential.rotate', 'u-rotator'],
    ] as const) {
      const entry = entries.find((candidate) => candidate.action === action);
      assert.deepEqual(
        [entry?.actorUserId, entry?.targetType, entry?.targetId, entry?.meta],
        [actor, 'integration', integration.id, expected],
        action,
      );
    }

    const sealed = await (
      await models.getCredentialRepository()
    ).findSealed('w-audit', integration.id);
    assert.ok(sealed);
    const logged = JSON.stringify(entries);
    for (const secretData of [
      JIRA_SECRET.token,
      JIRA_SECRET_WITH_PROJECTS.projectsToken,
      rotatedToken,
      sealed.enc.ciphertext,
      sealed.enc.wrappedDataKey,
      sealed.enc.authTag,
      sealed.enc.iv,
    ]) {
      assert.ok(!logged.includes(secretData));
    }
  });

  it('the writer refuses an unknown integration (404) and a provider that is not the integration’s', async () => {
    const integration = await newIntegration('w-vault');
    await assert.rejects(
      store({ ...integration, id: 'no-such-integration' }, JIRA_SECRET),
      hasStatus(404),
    );
    await assert.rejects(
      writer.storeCredential({
        workspaceId: integration.workspaceId,
        integrationId: integration.id,
        provider: 'clickup',
        ownerUserId: 'u-owner',
        kind: 'api_token',
        secret: JIRA_SECRET,
      }),
    );
    assert.equal(await meta(integration), null);
    // Nothing was stored, so nothing was audited.
    const audited = await (
      await models.getAuditLogRepository()
    ).list(integration.workspaceId, {}, 100);
    assert.ok(!audited.some((entry) => entry.targetId === integration.id));
  });
});
