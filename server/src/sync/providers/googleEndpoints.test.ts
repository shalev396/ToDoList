/**
 * The Google endpoints and the test-only stand-in override (setGoogleBaseUrlForTests): a server
 * always talks to Google itself, and the exact-URL token allow-list takes the stand-in's URLs only
 * while a test points at it.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createReadOnlyClient, type Transport } from '../http.js';
import {
  GOOGLE_ENDPOINTS,
  googleEndpoints,
  mockGoogleEndpoint,
  setGoogleBaseUrlForTests,
} from './googleEndpoints.js';

const MOCK = 'http://127.0.0.1:3998';
const NO_TRANSPORT: Transport = {
  send: () => Promise.reject(new Error('no network in this test')),
};

afterEach(() => {
  setGoogleBaseUrlForTests(null);
});

describe('googleEndpoints', () => {
  it('is Google itself by default', () => {
    assert.deepEqual(googleEndpoints(), GOOGLE_ENDPOINTS);
    assert.equal(GOOGLE_ENDPOINTS.authorize, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(GOOGLE_ENDPOINTS.token, 'https://oauth2.googleapis.com/token');
    assert.equal(GOOGLE_ENDPOINTS.revoke, 'https://oauth2.googleapis.com/revoke');
    assert.equal(GOOGLE_ENDPOINTS.userinfo, 'https://openidconnect.googleapis.com/v1/userinfo');
    assert.equal(GOOGLE_ENDPOINTS.calendar, 'https://www.googleapis.com/calendar/v3');
    assert.equal(mockGoogleEndpoint('token'), null);
  });

  it("points every endpoint at a test's stand-in, and back", () => {
    setGoogleBaseUrlForTests(`${MOCK}/`);
    assert.deepEqual(googleEndpoints(), {
      authorize: `${MOCK}/o/oauth2/v2/auth`,
      token: `${MOCK}/token`,
      revoke: `${MOCK}/revoke`,
      userinfo: `${MOCK}/v1/userinfo`,
      calendar: `${MOCK}/calendar/v3`,
    });
    assert.equal(mockGoogleEndpoint('token'), `${MOCK}/token`);
    setGoogleBaseUrlForTests(null);
    assert.deepEqual(googleEndpoints(), GOOGLE_ENDPOINTS);
  });

  it('takes nothing but a loopback http origin', () => {
    for (const bad of [
      'https://attacker.example.com',
      'http://10.0.0.5:3998',
      'http://127.0.0.1:3998/path',
      'http://user:pw@127.0.0.1:3998',
      'file:///etc/passwd',
      'not a url',
    ]) {
      assert.throws(() => {
        setGoogleBaseUrlForTests(bad);
      }, /loopback http origin/);
    }
    assert.deepEqual(googleEndpoints(), GOOGLE_ENDPOINTS);
  });
});

describe('the exact-URL token allow-list', () => {
  it("refuses the stand-in's token and revoke URLs unless a test points at it", () => {
    assert.throws(
      () =>
        createReadOnlyClient({
          provider: 'google_calendar',
          transport: NO_TRANSPORT,
          tokenExchangeUrl: `${MOCK}/token`,
        }),
      /not allow-listed/,
    );
    assert.throws(
      () =>
        createReadOnlyClient({
          provider: 'google_calendar',
          transport: NO_TRANSPORT,
          revokeUrl: `${MOCK}/revoke`,
        }),
      /not allow-listed/,
    );
    setGoogleBaseUrlForTests(MOCK);
    const client = createReadOnlyClient({
      provider: 'google_calendar',
      transport: NO_TRANSPORT,
      tokenExchangeUrl: `${MOCK}/token`,
      revokeUrl: `${MOCK}/revoke`,
    });
    assert.equal(typeof client.revokeToken, 'function');
  });

  it('accepts Google’s own token and revoke URLs', () => {
    const client = createReadOnlyClient({
      provider: 'google_calendar',
      transport: NO_TRANSPORT,
      tokenExchangeUrl: GOOGLE_ENDPOINTS.token,
      revokeUrl: GOOGLE_ENDPOINTS.revoke,
    });
    assert.equal(typeof client.revokeToken, 'function');
  });
});
