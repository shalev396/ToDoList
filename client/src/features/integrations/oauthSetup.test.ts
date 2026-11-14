import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OAuthProviderInfo } from '@api-types/integrations.ts';
import { connect as en } from '../../i18n/translations/en/connect.ts';
import { connect as he } from '../../i18n/translations/he/connect.ts';
import {
  hasOAuthSignIn,
  hasResourcePicker,
  hasTokenFallback,
  isOAuthSignIn,
  oauthMode,
  REVOKE_PAGES,
  revokesOnDisconnect,
} from './oauthSetup.ts';
import { isComingSoon, PROVIDER_ORDER } from './providers.ts';

const info = (over: Partial<OAuthProviderInfo> = {}): OAuthProviderInfo => ({
  provider: 'linear',
  configured: false,
  installUrl: null,
  ...over,
});

describe('oauthMode: what a provider card offers', () => {
  it('connects when the stage has the OAuth app', () => {
    assert.equal(oauthMode(info({ configured: true }), false), 'connect');
  });
  it('says sign-in is not available yet when it has none, on every stage', () => {
    assert.equal(oauthMode(info(), false), 'unavailable');
    assert.equal(oauthMode(undefined, false), 'unavailable');
  });
  it('waits while the answer is on its way', () => {
    assert.equal(oauthMode(undefined, true), 'checking');
  });
});

describe('who signs in, and who also takes a token', () => {
  it('GitHub, Jira, ClickUp, Linear and Google Calendar sign in; Moodle does not', () => {
    assert.ok(['github', 'jira', 'clickup', 'linear', 'google_calendar'].every(hasOAuthSignIn));
    assert.ok(!hasOAuthSignIn('moodle'));
    assert.ok(['github', 'jira', 'clickup', 'linear'].every(isOAuthSignIn));
    assert.ok(!isOAuthSignIn('google_calendar'));
  });
  it('offers an API token fallback to all but Google Calendar and Moodle', () => {
    assert.ok(['github', 'jira', 'clickup', 'linear'].every(hasTokenFallback));
    assert.ok(!hasTokenFallback('google_calendar') && !hasTokenFallback('moodle'));
  });
  it('knows which providers pick resources and revoke', () => {
    assert.ok(hasResourcePicker('jira') && hasResourcePicker('clickup'));
    assert.ok(!hasResourcePicker('linear') && !hasResourcePicker('github'));
    assert.ok(revokesOnDisconnect('linear') && !revokesOnDisconnect('jira'));
    assert.deepEqual(Object.keys(REVOKE_PAGES).sort(), ['clickup', 'github', 'jira', 'linear']);
  });
});

describe('the provider list', () => {
  it('runs Jira, ClickUp, Linear, Google Calendar, GitHub, then Moodle, coming soon', () => {
    assert.deepEqual(PROVIDER_ORDER, [
      'jira',
      'clickup',
      'linear',
      'google_calendar',
      'github',
      'moodle',
    ]);
    assert.deepEqual(PROVIDER_ORDER.filter(isComingSoon), ['moodle']);
  });
});

describe('sign-in texts: English and Hebrew carry the same keys', () => {
  const keysOf = (value: unknown, prefix = ''): string[] =>
    typeof value === 'object' && value !== null
      ? Object.entries(value).flatMap(([key, child]) => keysOf(child, `${prefix}${key}.`))
      : [prefix];
  for (const section of ['signin', 'resources'] as const) {
    it(section, () => {
      assert.deepEqual(keysOf(he[section]).sort(), keysOf(en[section]).sort());
    });
  }
  it('has a consent line for every provider that signs in, read access only', () => {
    for (const provider of ['github', 'jira', 'clickup', 'linear', 'google_calendar'] as const) {
      assert.ok(en.signin.consent[provider].length > 0);
      assert.ok(he.signin.consent[provider].length > 0);
    }
    assert.ok(!/write/i.test(JSON.stringify(en.signin.consent)));
  });
  it('never tells a user to create an app: no setup guide, in either language', () => {
    assert.ok(!('guide' in en) && !('guide' in he));
    assert.ok(!('setup' in en.signin) && !('setup' in he.signin));
    assert.ok(!/client (id|secret)|developer console|register/i.test(JSON.stringify(en.signin)));
  });
});
