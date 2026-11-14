import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import {
  decodeJwt,
  FAKE_CLIENT_EMAIL,
  FAKE_UNUSABLE_PEM,
  fakeServiceAccount,
} from '../../testing/fakeServiceAccount.js';
import {
  createReadOnlyClient,
  GOOGLE_TOKEN_URL,
  ProviderHttpError,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from '../http.js';
import { fixtureTransport } from '../transports/fixtures.js';
import {
  bearerHeaders,
  CALENDAR_READONLY_SCOPE,
  JWT_BEARER_GRANT,
  serviceAccountToken,
  signServiceAccountAssertion,
} from './googleAuth.js';

const NOW = new Date('2026-11-12T08:00:00.000Z');
const NOW_S = NOW.getTime() / 1000;
const ACCESS_TOKEN = 'ya29.FAKE-access-token-googleAuth-test';

/** Answers the token POST and records what was sent. */
function tokenEndpoint(): Transport & { seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  return {
    seen,
    send: (request: HttpRequest): Promise<HttpResponse> => {
      seen.push(request);
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({
          access_token: ACCESS_TOKEN,
          expires_in: 3599,
          token_type: 'Bearer',
        }),
      });
    },
  };
}

function client(transport: Transport): ReturnType<typeof createReadOnlyClient> {
  return createReadOnlyClient({
    provider: 'google_calendar',
    transport,
    tokenExchangeUrl: GOOGLE_TOKEN_URL,
  });
}

/** The form fields of a url-encoded body. */
function formOf(request: HttpRequest | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(request?.body ?? ''));
}

describe('signServiceAccountAssertion', () => {
  it('signs an RS256 JWT for the token endpoint: issuer, scope, one hour', () => {
    const account = fakeServiceAccount();
    const jwt = signServiceAccountAssertion('google_calendar', account.secret.privateKey, {
      clientEmail: FAKE_CLIENT_EMAIL,
      scope: CALENDAR_READONLY_SCOPE,
      issuedAt: NOW_S,
    });
    const decoded = decodeJwt(jwt, account.publicKey);
    assert.equal(decoded.verified, true);
    assert.deepEqual(decoded.header, { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(decoded.claims, {
      iss: FAKE_CLIENT_EMAIL,
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: NOW_S,
      exp: NOW_S + 3600,
    });
    assert.equal(CALENDAR_READONLY_SCOPE, 'https://www.googleapis.com/auth/calendar.readonly');
  });

  it('accepts a key whose newlines arrived escaped (\\n), as pasted from an env file', () => {
    const account = fakeServiceAccount();
    const escaped = account.secret.privateKey.replace(/\n/g, '\\n');
    assert.ok(!escaped.includes('\n'));
    const jwt = signServiceAccountAssertion('google_calendar', escaped, {
      clientEmail: FAKE_CLIENT_EMAIL,
      scope: CALENDAR_READONLY_SCOPE,
      issuedAt: NOW_S,
    });
    assert.equal(decodeJwt(jwt, account.publicKey).verified, true);
  });

  it('a key that cannot sign is auth_failed, and the error never shows the key', () => {
    for (const key of [FAKE_UNUSABLE_PEM, 'FAKE not a key at all', ' ']) {
      assert.throws(
        () =>
          signServiceAccountAssertion('google_calendar', key, {
            clientEmail: FAKE_CLIENT_EMAIL,
            scope: CALENDAR_READONLY_SCOPE,
            issuedAt: NOW_S,
          }),
        (error: unknown) => {
          assert.ok(error instanceof ProviderHttpError);
          assert.deepEqual(
            [error.provider, error.status, error.code],
            ['google_calendar', null, 'auth_failed'],
          );
          const shown = `${String(error)} ${error.stack ?? ''} ${inspect(error, { showHidden: true, depth: 10 })}`;
          assert.equal(shown.includes('FAKEbm90'), false);
          assert.equal(shown.includes('PRIVATE KEY'), false);
          return true;
        },
      );
    }
  });
});

describe('serviceAccountToken', () => {
  it('exchanges a signed assertion (JWT bearer grant) for the access token', async () => {
    const account = fakeServiceAccount();
    const transport = tokenEndpoint();
    const token = await serviceAccountToken(
      { client: client(transport), secret: account.secret, now: NOW },
      'google_calendar',
      CALENDAR_READONLY_SCOPE,
    );
    assert.equal(token, ACCESS_TOKEN);
    assert.equal(transport.seen.length, 1);
    const [sent] = transport.seen;
    assert.deepEqual([sent?.method, sent?.url], ['POST', GOOGLE_TOKEN_URL]);
    const form = formOf(sent);
    assert.deepEqual(Object.keys(form).sort(), ['assertion', 'grant_type']);
    assert.equal(form['grant_type'], JWT_BEARER_GRANT);
    assert.equal(JWT_BEARER_GRANT, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const decoded = decodeJwt(form['assertion'] ?? '', account.publicKey);
    assert.equal(decoded.verified, true);
    assert.deepEqual(
      [decoded.claims['iss'], decoded.claims['scope'], decoded.claims['aud']],
      [FAKE_CLIENT_EMAIL, CALENDAR_READONLY_SCOPE, GOOGLE_TOKEN_URL],
    );
    assert.deepEqual(bearerHeaders(token), { authorization: `Bearer ${ACCESS_TOKEN}` });
  });

  it('back-dates the assertion 60 s for clock skew, and it lasts no more than an hour', async () => {
    const account = fakeServiceAccount();
    const transport = tokenEndpoint();
    await serviceAccountToken(
      { client: client(transport), secret: account.secret, now: NOW },
      'google_calendar',
      CALENDAR_READONLY_SCOPE,
    );
    const { claims } = decodeJwt(formOf(transport.seen[0])['assertion'] ?? '', account.publicKey);
    assert.deepEqual([claims['iat'], claims['exp']], [NOW_S - 60, NOW_S - 60 + 3600]);
    assert.ok(Number(claims['exp']) - Number(claims['iat']) <= 3600);
    assert.ok(Number(claims['exp']) > NOW_S, 'still valid when it reaches Google');
  });

  it('fixtures mode has no secret: an empty assertion, and the recorded response answers', async () => {
    const transport = fixtureTransport([
      {
        request: { method: 'POST', url: GOOGLE_TOKEN_URL },
        response: { body: { access_token: ACCESS_TOKEN, token_type: 'Bearer' } },
      },
    ]);
    const token = await serviceAccountToken(
      { client: client(transport), secret: {}, now: NOW },
      'google_calendar',
      CALENDAR_READONLY_SCOPE,
    );
    assert.equal(token, ACCESS_TOKEN);
    assert.deepEqual(formOf(transport.calls[0]), {
      grant_type: JWT_BEARER_GRANT,
      assertion: '',
    });
  });

  it('a key that cannot sign fails before anything is sent', async () => {
    const transport = tokenEndpoint();
    await assert.rejects(
      serviceAccountToken(
        {
          client: client(transport),
          secret: { clientEmail: FAKE_CLIENT_EMAIL, privateKey: FAKE_UNUSABLE_PEM },
          now: NOW,
        },
        'google_calendar',
        CALENDAR_READONLY_SCOPE,
      ),
      (error: unknown) => error instanceof ProviderHttpError && error.code === 'auth_failed',
    );
    assert.equal(transport.seen.length, 0);
  });
});
