import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  OAuthProviderInfo,
  OAuthProvidersResponse,
  ProviderCapabilities,
} from '@api-types/integrations.ts';
import { connect as en } from '../../i18n/translations/en/connect.ts';
import { connect as he } from '../../i18n/translations/he/connect.ts';
import {
  capabilitiesOf,
  comingSoonOf,
  hasOAuthSignIn,
  hasResourcePicker,
  hasTokenFallback,
  isOAuthSignIn,
  oauthMode,
  revokePageOf,
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
});

const cap = (
  provider: ProviderCapabilities['provider'],
  over: Partial<ProviderCapabilities> = {},
): ProviderCapabilities => ({
  provider,
  authMethods: ['oauth'],
  picker: null,
  revokesOnDisconnect: false,
  revokePage: null,
  canCreate: false,
  canUpdate: false,
  writableFields: [],
  comingSoon: false,
  ...over,
});

/**
 * The server's real answer (Integration.capabilitiesOf, pinned in the server's
 * definitions.test.ts), in CONNECTABLE_PROVIDERS order.
 */
const response: OAuthProvidersResponse = {
  stage: 'dev',
  providers: [],
  capabilities: [
    cap('jira', {
      authMethods: ['oauth', 'api_token_basic'],
      picker: 'sites',
      revokePage: 'https://id.atlassian.com/manage-profile/apps',
      canCreate: true,
      canUpdate: true,
      writableFields: ['title', 'status', 'dueAt', 'priority'],
    }),
    cap('clickup', {
      authMethods: ['oauth', 'personal_token'],
      picker: 'workspaces',
      revokePage: 'https://app.clickup.com/settings/apps',
      canCreate: true,
      canUpdate: true,
      writableFields: ['title', 'status', 'dueAt', 'startAt', 'priority'],
    }),
    cap('linear', {
      authMethods: ['oauth', 'personal_api_key'],
      revokesOnDisconnect: true,
      revokePage: 'https://linear.app/settings/account/security',
      canCreate: true,
      canUpdate: true,
      writableFields: ['title', 'status', 'dueAt', 'priority'],
    }),
    cap('moodle', { authMethods: ['moodle_ws_token'], comingSoon: true }),
    cap('google_calendar', {
      picker: 'calendars',
      revokesOnDisconnect: true,
      canCreate: true,
      canUpdate: true,
      writableFields: ['title', 'startAt', 'endAt'],
    }),
    cap('github', {
      authMethods: ['oauth', 'fine_grained_pat'],
      revokePage: 'https://github.com/settings/apps/authorizations',
      canCreate: true,
      canUpdate: true,
      writableFields: ['title', 'status'],
    }),
  ],
};
const caps = (provider: string) => capabilitiesOf(response, provider);

describe('capabilities from the providers answer', () => {
  it('finds a provider, and nothing before the answer has arrived', () => {
    assert.equal(caps('jira')?.provider, 'jira');
    assert.equal(caps('nope'), undefined);
    assert.equal(capabilitiesOf(undefined, 'jira'), undefined);
  });
  it('offers the resource picker to Jira and ClickUp only, not Google Calendar', () => {
    assert.ok(hasResourcePicker(caps('jira')) && hasResourcePicker(caps('clickup')));
    for (const provider of ['linear', 'github', 'google_calendar', 'moodle']) {
      assert.ok(!hasResourcePicker(caps(provider)), provider);
    }
  });
  it('revokes on disconnect for Linear (and Google Calendar), not for the rest', () => {
    assert.ok(revokesOnDisconnect(caps('linear')) && revokesOnDisconnect(caps('google_calendar')));
    for (const provider of ['github', 'jira', 'clickup', 'moodle']) {
      assert.ok(!revokesOnDisconnect(caps(provider)), provider);
    }
  });
  it('points GitHub, Jira, ClickUp and Linear at their revoke pages', () => {
    assert.equal(revokePageOf(caps('github')), 'https://github.com/settings/apps/authorizations');
    assert.equal(revokePageOf(caps('jira')), 'https://id.atlassian.com/manage-profile/apps');
    assert.equal(revokePageOf(caps('clickup')), 'https://app.clickup.com/settings/apps');
    assert.equal(revokePageOf(caps('linear')), 'https://linear.app/settings/account/security');
    assert.equal(revokePageOf(caps('google_calendar')), null);
    assert.equal(revokePageOf(caps('moodle')), null);
  });
  it('marks only Moodle as coming soon', () => {
    assert.deepEqual(
      PROVIDER_ORDER.filter((provider) => comingSoonOf(caps(provider), provider)),
      ['moodle'],
    );
  });
  it('claims nothing open until the answer is loaded: Moodle stays coming soon', () => {
    const none = capabilitiesOf(undefined, 'moodle');
    assert.ok(!hasResourcePicker(none) && !revokesOnDisconnect(none));
    assert.equal(revokePageOf(none), null);
    assert.deepEqual(
      PROVIDER_ORDER.filter((provider) => comingSoonOf(undefined, provider)),
      ['moodle'],
    );
  });
  it('an answer without capabilities (an older server) is read as not loaded, not a crash', () => {
    const older = { stage: 'dev' as const, providers: [] };
    assert.equal(capabilitiesOf(older, 'jira'), undefined);
    assert.ok(comingSoonOf(capabilitiesOf(older, 'moodle'), 'moodle'));
    assert.ok(!comingSoonOf(capabilitiesOf(older, 'jira'), 'jira'));
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
