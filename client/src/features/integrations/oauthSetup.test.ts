import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OAuthProviderInfo } from '@api-types/integrations.ts';
import { connect as en } from '../../i18n/translations/en/connect.ts';
import { connect as he } from '../../i18n/translations/he/connect.ts';
import {
  hasResourcePicker,
  isOAuthSignIn,
  oauthMode,
  REVOKE_PAGES,
  revokesOnDisconnect,
} from './oauthSetup.ts';

const info = (over: Partial<OAuthProviderInfo> = {}): OAuthProviderInfo => ({
  provider: 'linear',
  configured: false,
  callbackUrl: 'https://dev.example.test/api/public/oauth/linear/callback',
  scopes: ['read'],
  writeScopes: ['issues:create'],
  consoleUrl: 'https://linear.app/settings/api/applications/new',
  secretName: 'todolist/dev/oauth-linear',
  installUrl: null,
  ...over,
});

describe('oauthMode: what a provider card offers', () => {
  it('connects when the server has the OAuth app', () => {
    for (const stage of ['dev', 'qa', 'prod'] as const) {
      assert.equal(oauthMode(info({ configured: true }), stage), 'connect');
    }
  });
  it('offers the setup guide on dev and qa when it has none', () => {
    for (const stage of ['dev', 'qa'] as const) {
      assert.equal(oauthMode(info(), stage), 'setup');
    }
  });
  it('says sign-in is not available on prod when it has none', () => {
    assert.equal(oauthMode(info(), 'prod'), 'unavailable');
  });
  it('falls back to the token form while the answer is unknown', () => {
    assert.equal(oauthMode(undefined, 'dev'), 'token');
  });
});

describe('the setup guide data', () => {
  it('knows which providers sign in, pick resources and revoke', () => {
    assert.ok(['github', 'jira', 'clickup', 'linear'].every(isOAuthSignIn));
    assert.ok(!isOAuthSignIn('moodle') && !isOAuthSignIn('google_calendar'));
    assert.ok(hasResourcePicker('jira') && hasResourcePicker('clickup'));
    assert.ok(!hasResourcePicker('linear') && !hasResourcePicker('github'));
    assert.ok(revokesOnDisconnect('linear') && !revokesOnDisconnect('jira'));
    assert.deepEqual(Object.keys(REVOKE_PAGES).sort(), ['clickup', 'github', 'jira', 'linear']);
  });
});

describe('sign-in texts: English and Hebrew carry the same keys', () => {
  const keysOf = (value: unknown, prefix = ''): string[] =>
    typeof value === 'object' && value !== null
      ? Object.entries(value).flatMap(([key, child]) => keysOf(child, `${prefix}${key}.`))
      : [prefix];
  for (const section of ['signin', 'guide', 'resources'] as const) {
    it(section, () => {
      assert.deepEqual(keysOf(he[section]).sort(), keysOf(en[section]).sort());
    });
  }
  it('has a consent line and guide steps for every provider, read access only', () => {
    for (const provider of ['github', 'jira', 'clickup', 'linear'] as const) {
      assert.ok(en.signin.consent[provider].length > 0);
      assert.ok(Object.keys(en.guide.steps[provider]).length >= 3);
    }
    assert.ok(!/write/i.test(JSON.stringify(en.signin.consent)));
  });
});
