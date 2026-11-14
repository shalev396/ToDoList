import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONNECTABLE_PROVIDERS } from '@api-types/integrations.ts';
import {
  bodyFrom,
  configFields,
  credentialFields,
  missingFields,
  PROVIDER_ORDER,
  PROVIDER_REGISTRY,
} from './providers.ts';
import { SECRET_INPUT_PROPS, takeFormValues } from './secrets.ts';
import { errorKey } from '../../api/errors.ts';
import { oauthFailure, oauthReturnOf } from './oauthReturn.ts';
import { latestRun, needsRenewalHint, syncPollInterval } from './status.ts';

describe('provider registry', () => {
  it('covers exactly the server providers', () => {
    assert.deepEqual([...PROVIDER_ORDER].sort(), [...CONNECTABLE_PROVIDERS].sort());
    assert.deepEqual(Object.keys(PROVIDER_REGISTRY).sort(), [...CONNECTABLE_PROVIDERS].sort());
  });
  it('asks GitHub for two secrets, the second optional, and the owner as config', () => {
    const secrets = credentialFields('github').filter((f) => f.secret);
    assert.deepEqual(
      secrets.map((f) => [f.name, f.required]),
      [
        ['token', true],
        ['projectsToken', false],
      ],
    );
    assert.deepEqual(
      configFields('github').map((f) => f.name),
      ['owner', 'ownerType'],
    );
  });
  it('keeps the email of a Jira credential out of the secret fields', () => {
    assert.deepEqual(
      credentialFields('jira').map((f) => [f.name, f.secret]),
      [
        ['email', false],
        ['token', true],
      ],
    );
  });
  it('builds a body without empty optional fields', () => {
    const specs = credentialFields('github');
    assert.deepEqual(bodyFrom(specs, { token: ' abc ', projectsToken: '' }), { token: 'abc' });
    assert.deepEqual(missingFields(specs, { token: ' ' }), ['token']);
  });
});

describe('secret hygiene', () => {
  it('uses a write-only password input', () => {
    assert.equal(SECRET_INPUT_PROPS.type, 'password');
    assert.equal(SECRET_INPUT_PROPS.autoComplete, 'off');
  });
  it('reads the values once and empties the fields', () => {
    const token = { value: 'FAKE' };
    const fields: Record<string, { value: string }> = { token };
    const values = takeFormValues((name) => fields[name] ?? null, ['token', 'projectsToken']);
    assert.deepEqual(values, { token: 'FAKE', projectsToken: '' });
    assert.equal(token.value, '');
  });
});

describe('sync status', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  it('hints at renewal 14 days ahead', () => {
    assert.equal(needsRenewalHint('2026-06-20T00:00:00Z', now), false);
    assert.equal(needsRenewalHint('2026-06-14T00:00:00Z', now), true);
    assert.equal(needsRenewalHint(null, now), false);
  });
  it('polls only while a run is queued or running', () => {
    assert.equal(syncPollInterval([{ status: 'succeeded' }]), false);
    assert.equal(syncPollInterval([{ status: 'running' }, { status: 'succeeded' }]), 3000);
    assert.equal(syncPollInterval(undefined), false);
  });
  it('finds the newest run of an integration', () => {
    const runs = [
      { id: 'a', integrationId: 'x' },
      { id: 'b', integrationId: 'y' },
      { id: 'c', integrationId: 'x' },
    ];
    assert.equal(latestRun(runs, 'x')?.id, 'a');
    assert.equal(latestRun(runs, 'z'), undefined);
  });
});

describe('coming back from Google (oauthReturnOf)', () => {
  const read = (query: string) => oauthReturnOf(new URLSearchParams(query));

  it('reads a connection and an OAuth error code', () => {
    assert.deepEqual(read('connected=0c9c5a0e-6d8f-4b38-9a43-2f1d8e7c6b5a'), {
      kind: 'connected',
      integrationId: '0c9c5a0e-6d8f-4b38-9a43-2f1d8e7c6b5a',
    });
    assert.deepEqual(read('oauth_error=oauth_state_expired'), {
      kind: 'error',
      code: 'oauth_state_expired',
    });
  });

  it('ignores anything else, and never takes a code that is not an OAuth one', () => {
    assert.equal(read(''), null);
    assert.equal(read('connected=<script>'), null);
    assert.deepEqual(read('oauth_error=made_up'), { kind: 'error', code: null });
    assert.deepEqual(read('oauth_error=invite_used'), { kind: 'error', code: null });
  });

  it('turns the code into the shape errorMessage() reads', () => {
    assert.equal(errorKey(oauthFailure('oauth_denied'), 'fallback'), 'errors.codes.oauthDenied');
    assert.equal(errorKey(oauthFailure(null), 'fallback'), 'fallback');
  });
});
