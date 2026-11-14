import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import {
  createReadOnlyClient,
  DestinationRefusedError,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  ProviderHttpError,
  type HttpRequest,
  type HttpResponse,
  type ReadOnlyClient,
  type Transport,
} from './http.js';
import {
  FixtureMissingError,
  RedirectRefusedError,
  redactUrl,
  sanitizeProviderError,
} from './errors.js';
import { fixtureTransport } from './transports/fixtures.js';

/** Transport that answers from a queue and records every request it sees. */
function scripted(responses: HttpResponse[]): Transport & { seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  return {
    seen,
    send(request: HttpRequest): Promise<HttpResponse> {
      seen.push(request);
      const next = responses.shift();
      if (next === undefined) throw new Error('no scripted response left');
      return Promise.resolve(next);
    },
  };
}

const ok = (body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status: 200,
  headers,
  body: JSON.stringify(body),
});

/** A fake clock: sleep() advances time instantly so retries don't slow the suite. */
function fakeClock(start = 1_000_000): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
} {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number): Promise<void> => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    slept,
  };
}

describe('read-only provider client', () => {
  it('sends GET requests with the given headers and parses JSON', async () => {
    const transport = scripted([ok({ hello: 'world' })]);
    const client = createReadOnlyClient({ provider: 'jira', transport, clock: fakeClock() });
    const res = await client.getJson<{ hello: string }>('https://x.example/api', {
      accept: 'application/json',
    });
    assert.equal(res.data.hello, 'world');
    assert.equal(transport.seen[0]?.method, 'GET');
  });

  it('only POSTs allow-listed GraphQL documents', async () => {
    const transport = scripted([ok({ data: { viewer: { login: 'me' } } })]);
    const client = createReadOnlyClient({
      provider: 'github',
      transport,
      clock: fakeClock(),
      graphql: {
        endpoint: 'https://api.example/graphql',
        documents: { Viewer: 'query Viewer { viewer { login } }' },
      },
    });
    const data = await client.graphql<{ viewer: { login: string } }>('Viewer', {});
    assert.equal(data.viewer.login, 'me');
    const sent = transport.seen[0];
    assert.ok(sent);
    assert.equal(sent.method, 'POST');
    assert.deepEqual(JSON.parse(sent.body ?? '{}'), {
      query: 'query Viewer { viewer { login } }',
      variables: {},
    });
    await assert.rejects(client.graphql('NotListed', {}), /not allow-listed/);
  });

  it('refuses to build a client whose GraphQL documents contain a mutation or subscription', () => {
    for (const doc of [
      'mutation M { x }',
      'query Q { a } mutation B { y }',
      'subscription S { s }',
    ]) {
      assert.throws(
        () =>
          createReadOnlyClient({
            provider: 'linear',
            transport: scripted([]),
            graphql: { endpoint: 'https://api.example/graphql', documents: { Bad: doc } },
          }),
        /read-only/,
      );
    }
  });

  it('surfaces GraphQL errors as a provider error without echoing the response', async () => {
    const transport = scripted([
      ok({ errors: [{ message: 'token lin_api_FAKEabcdefghijklmnopqrstuv invalid' }] }),
    ]);
    const client = createReadOnlyClient({
      provider: 'linear',
      transport,
      clock: fakeClock(),
      graphql: { endpoint: 'https://api.example/graphql', documents: { Q: 'query Q { a }' } },
    });
    await assert.rejects(client.graphql('Q', {}), (error: unknown) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.code, 'bad_response');
      assert.equal(error.message.includes('lin_api_'), false);
      return true;
    });
  });

  it('waits for Retry-After on 429 and then succeeds', async () => {
    const clock = fakeClock();
    const transport = scripted([
      { status: 429, headers: { 'retry-after': '7' }, body: '' },
      ok({ n: 1 }),
    ]);
    const client = createReadOnlyClient({ provider: 'jira', transport, clock });
    const res = await client.getJson<{ n: number }>('https://x.example/a');
    assert.equal(res.data.n, 1);
    assert.ok(clock.slept.includes(7000), `slept ${JSON.stringify(clock.slept)}`);
  });

  it('retries 5xx with backoff, then gives up with a sanitized error', async () => {
    const clock = fakeClock();
    const failing: HttpResponse = { status: 502, headers: {}, body: '<html>bad gateway</html>' };
    const transport = scripted([failing, failing, failing, failing]);
    const client = createReadOnlyClient({ provider: 'clickup', transport, clock, maxRetries: 3 });
    await assert.rejects(client.getJson('https://x.example/a'), (error: unknown) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.deepEqual(sanitizeProviderError(error), {
        provider: 'clickup',
        status: 502,
        code: 'server_error',
      });
      return true;
    });
    assert.equal(transport.seen.length, 4);
    assert.equal(clock.slept.length, 3);
  });

  it('does not retry auth failures and labels them auth_failed', async () => {
    const transport = scripted([
      { status: 401, headers: {}, body: '{"message":"Bearer x revoked"}' },
    ]);
    const client = createReadOnlyClient({ provider: 'github', transport, clock: fakeClock() });
    await assert.rejects(client.getJson('https://x.example/a'), (error: unknown) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.code, 'auth_failed');
      return true;
    });
    assert.equal(transport.seen.length, 1);
  });

  it('does not retry a missing fixture: the same request would miss again', async () => {
    const clock = fakeClock();
    const seen: HttpRequest[] = [];
    const transport: Transport = {
      send: (request) => {
        seen.push(request);
        return Promise.reject(new FixtureMissingError('GET https://x.example/a'));
      },
    };
    const client = createReadOnlyClient({ provider: 'jira', transport, clock });
    await assert.rejects(client.getJson('https://x.example/a'), FixtureMissingError);
    assert.equal(seen.length, 1);
    assert.deepEqual(clock.slept, []);
  });

  it('a destination the transport refused (netGuard) is network at once: not retried, nothing echoed', async () => {
    const clock = fakeClock();
    const seen: HttpRequest[] = [];
    const transport: Transport = {
      send: (request) => {
        seen.push(request);
        return Promise.reject(new DestinationRefusedError());
      },
    };
    const client = createReadOnlyClient({ provider: 'jira', transport, clock });
    await assert.rejects(client.getJson('https://10.0.0.7/rest/api/3/myself'), (error: unknown) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.deepEqual(sanitizeProviderError(error), {
        provider: 'jira',
        status: null,
        code: 'network',
      });
      assert.equal(String(error).includes('10.0.0.7'), false);
      return true;
    });
    assert.equal(seen.length, 1);
    assert.deepEqual(clock.slept, []);
  });

  it('DestinationRefusedError names neither the URL nor the address', () => {
    const error = new DestinationRefusedError();
    assert.equal(error.name, 'DestinationRefusedError');
    assert.equal(error.message, 'Refused to connect: not a public https destination');
  });

  it('GitHub’s secondary limit (403 + Retry-After) is rate_limited: it waits, then goes on', async () => {
    const clock = fakeClock();
    const transport = scripted([
      {
        status: 403,
        headers: { 'retry-after': '45', 'x-ratelimit-remaining': '4321' },
        body: '{"message":"You have exceeded a secondary rate limit"}',
      },
      ok({ n: 1 }),
    ]);
    const client = createReadOnlyClient({ provider: 'github', transport, clock });
    const res = await client.getJson<{ n: number }>('https://api.example/repos');
    assert.equal(res.data.n, 1);
    assert.equal(transport.seen.length, 2);
    assert.deepEqual(clock.slept, [45_000]);
  });

  it('a spent hourly budget (403 + x-ratelimit-remaining: 0) waits for x-ratelimit-reset', async () => {
    // A real epoch: x-ratelimit-reset is epoch seconds.
    const clock = fakeClock(Date.UTC(2026, 10, 12, 9, 0, 0));
    const resetAt = Math.floor((clock.now() + 30_000) / 1000);
    const transport = scripted([
      {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) },
        body: '{"message":"API rate limit exceeded"}',
      },
      ok({ n: 2 }),
    ]);
    const client = createReadOnlyClient({ provider: 'github', transport, clock });
    const res = await client.getJson<{ n: number }>('https://api.example/repos');
    assert.equal(res.data.n, 2);
    assert.equal(clock.slept.length, 1);
    const [slept] = clock.slept;
    assert.ok(slept !== undefined && slept > 29_000 && slept <= 30_000, `slept ${String(slept)}`);
  });

  it('a 403 rate limit that never lifts ends rate_limited (retried by the worker), never auth_failed', async () => {
    for (const headers of [
      { 'retry-after': '1' },
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' },
    ]) {
      const limited: HttpResponse = { status: 403, headers, body: '{}' };
      const transport = scripted([limited, limited, limited, limited]);
      const client = createReadOnlyClient({ provider: 'github', transport, clock: fakeClock() });
      await assert.rejects(client.getJson('https://api.example/repos'), (error: unknown) => {
        assert.ok(error instanceof ProviderHttpError);
        assert.deepEqual(sanitizeProviderError(error), {
          provider: 'github',
          status: 403,
          code: 'rate_limited',
        });
        return true;
      });
      assert.equal(transport.seen.length, 4, JSON.stringify(headers));
    }
  });

  it('a plain 403 is still auth_failed, at once: no Retry-After, budget left or blank', async () => {
    for (const headers of [
      {},
      { 'x-ratelimit-remaining': '4999' },
      { 'x-ratelimit-reset': '1' },
      { 'retry-after': ' ' },
    ]) {
      const clock = fakeClock();
      const transport = scripted([{ status: 403, headers, body: '{"message":"Forbidden"}' }]);
      const client = createReadOnlyClient({ provider: 'github', transport, clock });
      await assert.rejects(client.getJson('https://api.example/repos'), (error: unknown) => {
        assert.ok(error instanceof ProviderHttpError);
        assert.equal(error.code, 'auth_failed', JSON.stringify(headers));
        return true;
      });
      assert.equal(transport.seen.length, 1, JSON.stringify(headers));
      assert.deepEqual(clock.slept, []);
    }
  });

  it('a 401 is auth_failed even with Retry-After', async () => {
    const transport = scripted([{ status: 401, headers: { 'retry-after': '30' }, body: '{}' }]);
    const client = createReadOnlyClient({ provider: 'github', transport, clock: fakeClock() });
    await assert.rejects(
      client.getJson('https://api.example/user'),
      (error: unknown) => error instanceof ProviderHttpError && error.code === 'auth_failed',
    );
    assert.equal(transport.seen.length, 1);
  });
});

describe('maxRetries: the client option and the transport cap', () => {
  /** Answers every request alike (or fails it like a network), counting them. */
  function always(
    reply: HttpResponse | 'network',
    maxRetries?: number,
  ): Transport & { seen: HttpRequest[] } {
    const seen: HttpRequest[] = [];
    return {
      seen,
      ...(maxRetries === undefined ? {} : { maxRetries }),
      send(request: HttpRequest): Promise<HttpResponse> {
        seen.push(request);
        return reply === 'network'
          ? Promise.reject(new Error('connect ECONNREFUSED'))
          : Promise.resolve(reply);
      },
    };
  }

  const FAILURES: [string, HttpResponse | 'network', string][] = [
    ['a 500', { status: 500, headers: {}, body: '' }, 'server_error'],
    ['a 503', { status: 503, headers: {}, body: '' }, 'server_error'],
    [
      'a 429 with Retry-After: 30',
      { status: 429, headers: { 'retry-after': '30' }, body: '' },
      'rate_limited',
    ],
    [
      'a 403 with Retry-After: 30',
      { status: 403, headers: { 'retry-after': '30' }, body: '' },
      'rate_limited',
    ],
    ['a network failure', 'network', 'network'],
  ];

  for (const [what, reply, code] of FAILURES) {
    it(`maxRetries 0 (client option): ${what} → ${code} after one request, without waiting`, async () => {
      const clock = fakeClock();
      const transport = always(reply);
      const client = createReadOnlyClient({ provider: 'jira', transport, clock, maxRetries: 0 });
      await assert.rejects(
        client.getJson('https://x.example/a'),
        (error: unknown) => error instanceof ProviderHttpError && error.code === code,
      );
      assert.equal(transport.seen.length, 1);
      assert.deepEqual(clock.slept, []);
    });

    it(`maxRetries 0 on the transport caps a client built without the option: ${what}`, async () => {
      const clock = fakeClock();
      const transport = always(reply, 0);
      const client = createReadOnlyClient({ provider: 'jira', transport, clock });
      await assert.rejects(
        client.getJson('https://x.example/a'),
        (error: unknown) => error instanceof ProviderHttpError && error.code === code,
      );
      assert.equal(transport.seen.length, 1);
      assert.deepEqual(clock.slept, []);
    });
  }

  it('the lower of the two wins: an adapter asking for more retries cannot exceed the transport', async () => {
    const failing: HttpResponse = { status: 502, headers: {}, body: '' };
    const cases: [number | undefined, number | undefined, number][] = [
      // [client option, transport cap, requests sent]
      [undefined, undefined, 4],
      [5, undefined, 6],
      [undefined, 1, 2],
      [5, 0, 1],
      [5, 2, 3],
      [1, 3, 2],
      [0, 3, 1],
    ];
    for (const [option, cap, sent] of cases) {
      const transport = always(failing, cap);
      const client = createReadOnlyClient({
        provider: 'jira',
        transport,
        clock: fakeClock(),
        ...(option === undefined ? {} : { maxRetries: option }),
      });
      await assert.rejects(client.getJson('https://x.example/a'), ProviderHttpError);
      assert.equal(transport.seen.length, sent, `option ${String(option)}, cap ${String(cap)}`);
    }
  });

  it('a cap that is not a whole number ≥ 0 means no retries at all (fails closed)', async () => {
    for (const cap of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const transport = always({ status: 500, headers: {}, body: '' }, cap);
      const client = createReadOnlyClient({ provider: 'jira', transport, clock: fakeClock() });
      await assert.rejects(client.getJson('https://x.example/a'), ProviderHttpError);
      assert.equal(transport.seen.length, 1, String(cap));
    }
  });

  it('maxRetries 0 still answers a success at once', async () => {
    const transport = always(ok({ fine: true }), 0);
    const client = createReadOnlyClient({ provider: 'jira', transport, clock: fakeClock() });
    assert.deepEqual((await client.getJson('https://x.example/a')).data, { fine: true });
    assert.equal(transport.seen.length, 1);
  });
});

describe('read-only provider client: request spacing', () => {
  it('spaces requests by the provider throttle', async () => {
    const clock = fakeClock();
    const transport = scripted([ok({}), ok({}), ok({})]);
    const client = createReadOnlyClient({
      provider: 'clickup',
      transport,
      clock,
      minIntervalMs: 700,
    });
    await client.getJson('https://x.example/1');
    await client.getJson('https://x.example/2');
    await client.getJson('https://x.example/3');
    assert.deepEqual(clock.slept, [700, 700]);
  });
});

describe('GraphQL partial results (graphqlPartial)', () => {
  const SECRET_TEXT =
    'Could not resolve to a node with the global id of FAKE-node-0042 (token FAKE)';

  function boardsClient(responses: HttpResponse[]): {
    client: ReadOnlyClient;
    transport: Transport & { seen: HttpRequest[] };
  } {
    const transport = scripted(responses);
    const client = createReadOnlyClient({
      provider: 'github',
      transport,
      clock: fakeClock(),
      graphql: {
        endpoint: 'https://api.example/graphql',
        documents: { Boards: 'query Boards($ids: [ID!]!) { nodes(ids: $ids) { id } }' },
      },
    });
    return { client, transport };
  }

  it('data AND errors: the data, and each error as {path, type}, never its message', async () => {
    const { client } = boardsClient([
      ok({
        data: { nodes: [{ id: 'B1' }, null, { id: 'B3' }] },
        errors: [
          { type: 'NOT_FOUND', path: ['nodes', 1], message: SECRET_TEXT, locations: [] },
          { message: SECRET_TEXT, path: ['nodes', 2, 'items'], extensions: { code: 'FORBIDDEN' } },
          { message: SECRET_TEXT },
        ],
      }),
    ]);
    const result = await client.graphqlPartial<{ nodes: ({ id: string } | null)[] }>('Boards', {
      ids: ['B1', 'B2', 'B3'],
    });
    assert.deepEqual(result, {
      data: { nodes: [{ id: 'B1' }, null, { id: 'B3' }] },
      errors: [
        { path: ['nodes', 1], type: 'NOT_FOUND' },
        { path: ['nodes', 2, 'items'], type: 'FORBIDDEN' },
        { path: [], type: null },
      ],
    });
    assert.equal(JSON.stringify(result).includes('FAKE-node-0042'), false);
  });

  it('data without errors: an empty list', async () => {
    const { client } = boardsClient([ok({ data: { nodes: [] } })]);
    assert.deepEqual(await client.graphqlPartial('Boards', { ids: [] }), {
      data: { nodes: [] },
      errors: [],
    });
  });

  it('errors without data (missing or null) → bad_response, the message not echoed', async () => {
    for (const body of [
      { errors: [{ type: 'NOT_FOUND', message: SECRET_TEXT }] },
      { data: null, errors: [{ type: 'FORBIDDEN', message: SECRET_TEXT }] },
      { data: 'not an object', errors: [] },
      { data: [{ id: 'B1' }] },
      {},
    ]) {
      const { client, transport } = boardsClient([ok(body)]);
      await assert.rejects(client.graphqlPartial('Boards', { ids: ['B1'] }), (error: unknown) => {
        assert.ok(error instanceof ProviderHttpError, JSON.stringify(body));
        assert.equal(error.code, 'bad_response', JSON.stringify(body));
        assert.equal(String(error).includes('FAKE-node-0042'), false);
        return true;
      });
      assert.equal(transport.seen.length, 1, 'not retried');
    }
  });

  it('a RATE_LIMITED error is rate_limited, with or without data', async () => {
    for (const body of [
      { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
      { data: { nodes: [] }, errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] },
      { data: { nodes: [] }, errors: [{ extensions: { code: 'RATE_LIMITED' } }] },
    ]) {
      const { client } = boardsClient([ok(body)]);
      await assert.rejects(
        client.graphqlPartial('Boards', { ids: [] }),
        (error: unknown) => error instanceof ProviderHttpError && error.code === 'rate_limited',
        JSON.stringify(body),
      );
    }
  });

  it('keeps only plain paths and codes: anything else is dropped, not passed on', async () => {
    const { client } = boardsClient([
      ok({
        data: { nodes: [] },
        errors: [
          { path: ['nodes', -1], type: 'NOT_FOUND' },
          { path: ['nodes', 1.5], type: 'NOT_FOUND' },
          { path: ['nodes', { id: 'x' }], type: 'NOT_FOUND' },
          { path: ['../etc/passwd'], type: 'NOT_FOUND' },
          { path: 'nodes.1', type: 'NOT_FOUND' },
          { path: ['nodes', 0], type: 'Not Found: see FAKE-node-0042' },
          { path: ['nodes', 0], type: 42 },
          { path: ['nodes', 0], extensions: { code: 'x'.repeat(200) } },
          'not an object',
          null,
        ],
      }),
    ]);
    const { errors } = await client.graphqlPartial('Boards', { ids: [] });
    assert.deepEqual(errors, [
      { path: [], type: 'NOT_FOUND' },
      { path: [], type: 'NOT_FOUND' },
      { path: [], type: 'NOT_FOUND' },
      { path: [], type: 'NOT_FOUND' },
      { path: [], type: 'NOT_FOUND' },
      { path: ['nodes', 0], type: null },
      { path: ['nodes', 0], type: null },
      { path: ['nodes', 0], type: null },
      { path: [], type: null },
      { path: [], type: null },
    ]);
  });

  it('an `errors` that is not a list → bad_response', async () => {
    const { client } = boardsClient([
      ok({ data: { nodes: [] }, errors: { message: SECRET_TEXT } }),
    ]);
    await assert.rejects(
      client.graphqlPartial('Boards', { ids: [] }),
      (error: unknown) => error instanceof ProviderHttpError && error.code === 'bad_response',
    );
  });

  it('only allow-listed documents, as graphql()', async () => {
    const { client, transport } = boardsClient([]);
    await assert.rejects(client.graphqlPartial('NotListed', {}), /not allow-listed/);
    assert.equal(transport.seen.length, 0);
  });

  it('graphql() stays strict: data AND errors → bad_response, so no caller reads half a result', async () => {
    const { client } = boardsClient([
      ok({
        data: { nodes: [{ id: 'B1' }, null] },
        errors: [{ type: 'NOT_FOUND', path: ['nodes', 1], message: SECRET_TEXT }],
      }),
    ]);
    await assert.rejects(client.graphql('Boards', { ids: ['B1', 'B2'] }), (error: unknown) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.code, 'bad_response');
      assert.equal(String(error).includes('FAKE-node-0042'), false);
      return true;
    });
  });
});

describe('token exchange: the one POST that is not GraphQL', () => {
  const FORM = {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: 'FAKE.assertion-signed-FAKE.value',
  };
  const ACCESS_TOKEN = 'ya29.FAKE-access-token-0123456789abcdef';

  function tokenClient(transport: Transport): ReadOnlyClient {
    return createReadOnlyClient({
      provider: 'google_drive',
      transport,
      clock: fakeClock(),
      tokenExchangeUrl: GOOGLE_TOKEN_URL,
    });
  }

  /** Every way an error could be printed: none may carry the given values. */
  function assertEchoesNothing(error: unknown, values: readonly string[]): void {
    const views = [
      String(error),
      error instanceof Error ? (error.stack ?? '') : '',
      inspect(error, { depth: 10, showHidden: true }),
      JSON.stringify(error),
    ];
    for (const value of values) {
      assert.equal(
        views.some((view) => view.includes(value)),
        false,
        `the error shows ${value}`,
      );
    }
  }

  it('POSTs the form, url-encoded, to exactly https://oauth2.googleapis.com/token', async () => {
    const transport = scripted([
      ok({ access_token: ACCESS_TOKEN, expires_in: 3599, token_type: 'Bearer' }),
    ]);
    const grant = await tokenClient(transport).exchangeToken(FORM);
    assert.deepEqual(grant, {
      accessToken: ACCESS_TOKEN,
      expiresIn: 3599,
      refreshToken: null,
      scope: null,
    });
    assert.equal(GOOGLE_TOKEN_URL, 'https://oauth2.googleapis.com/token');
    assert.deepEqual(transport.seen, [
      {
        method: 'POST',
        url: 'https://oauth2.googleapis.com/token',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=FAKE.assertion-signed-FAKE.value',
      },
    ]);
  });

  it('refuses to build a client that would exchange tokens at any other URL', () => {
    for (const url of [
      'http://oauth2.googleapis.com/token',
      'https://oauth2.googleapis.com/token/',
      'https://oauth2.googleapis.com/token?access_type=offline',
      'https://oauth2.googleapis.com/token#x',
      'https://oauth2.googleapis.com:443/token',
      'https://OAUTH2.googleapis.com/token',
      'https://user@oauth2.googleapis.com/token',
      'https://oauth2.googleapis.com/revoke',
      'https://oauth2.googleapis.com/',
      'https://www.googleapis.com/oauth2/v4/token',
      'https://accounts.google.com/o/oauth2/token',
      'https://oauth2.googleapis.com.example.invalid/token',
      'https://example.invalid/token',
      ' https://oauth2.googleapis.com/token',
      '',
      // A trailing dot names the same host to DNS, and plain http is still the token host.
      'https://oauth2.googleapis.com./token',
      'https://oauth2.googleapis.com../token',
      'http://oauth2.googleapis.com./token',
      'HTTPS://OAUTH2.GOOGLEAPIS.COM./token',
    ]) {
      assert.throws(
        () =>
          createReadOnlyClient({
            provider: 'google_drive',
            transport: scripted([]),
            tokenExchangeUrl: url,
          }),
        /not allow-listed/,
        url,
      );
    }
  });

  it('a client built without the token URL cannot exchange tokens', async () => {
    const transport = scripted([]);
    const client = createReadOnlyClient({ provider: 'jira', transport, clock: fakeClock() });
    await assert.rejects(client.exchangeToken(FORM), /not enabled/);
    assert.equal(transport.seen.length, 0);
  });

  it('reaches the token host by no other method: no GET, no GraphQL POST, no generic request', async () => {
    const transport = scripted([]);
    const client = tokenClient(transport);
    // The host is compared normalized (case, trailing dots) whatever the scheme or port.
    const variants = [
      GOOGLE_TOKEN_URL,
      `${GOOGLE_TOKEN_URL}?grant_type=x&assertion=FAKE-in-a-url`,
      'https://OAUTH2.GOOGLEAPIS.COM:443/token',
      'https://oauth2.googleapis.com/tokeninfo?access_token=FAKE',
      'http://oauth2.googleapis.com/token',
      'http://oauth2.googleapis.com:8080/token',
      'https://oauth2.googleapis.com./token',
      'https://oauth2.googleapis.com../token',
      'HTTP://OAUTH2.GOOGLEAPIS.COM./tokeninfo',
      'wss://oauth2.googleapis.com/token',
    ];
    for (const url of variants) {
      await assert.rejects(client.getJson(url), /only through exchangeToken/, url);
      assert.throws(
        () =>
          createReadOnlyClient({
            provider: 'github',
            transport,
            graphql: { endpoint: url, documents: { Q: 'query Q { a }' } },
          }),
        /only through exchangeToken/,
        url,
      );
    }
    // Look-alikes on other hosts are not the token host.
    for (const url of [
      'https://oauth2.googleapis.com.example.invalid/token',
      'https://www.googleapis.com/drive/v3/about',
    ]) {
      const ok = createReadOnlyClient({
        provider: 'google_drive',
        transport: scripted([{ status: 200, headers: {}, body: '{}' }]),
        clock: fakeClock(),
      });
      await ok.getJson(url);
    }
    assert.equal(transport.seen.length, 0);
    // GET, allow-listed GraphQL, this one exchange and the one revocation are the whole surface:
    // no request(method).
    assert.deepEqual(Object.keys(client).sort(), [
      'exchangeToken',
      'getJson',
      'graphql',
      'graphqlPartial',
      'revokeToken',
    ]);
  });

  it('a refused grant (400, 401) is auth_failed, not retried, and echoes nothing', async () => {
    for (const status of [400, 401]) {
      const transport = scripted([
        {
          status,
          headers: {},
          body: JSON.stringify({
            error: 'invalid_grant',
            error_description: `Invalid JWT ${FORM.assertion}`,
          }),
        },
      ]);
      await assert.rejects(tokenClient(transport).exchangeToken(FORM), (error: unknown) => {
        assert.ok(error instanceof ProviderHttpError);
        assert.deepEqual(sanitizeProviderError(error), {
          provider: 'google_drive',
          status,
          code: 'auth_failed',
        });
        assertEchoesNothing(error, [FORM.assertion, 'invalid_grant', 'Invalid JWT']);
        return true;
      });
      assert.equal(transport.seen.length, 1, `${String(status)} is not retried`);
    }
  });

  it('never surfaces the token: a response it cannot use is bad_response, without its body', async () => {
    for (const body of [
      JSON.stringify({ access_token: '', token_type: 'Bearer', hint: ACCESS_TOKEN }),
      JSON.stringify({ token_type: 'Bearer', id_token: ACCESS_TOKEN }),
      JSON.stringify({ access_token: ACCESS_TOKEN, token_type: 'MAC' }),
      JSON.stringify({ access_token: 42, refresh_token: ACCESS_TOKEN }),
      JSON.stringify([ACCESS_TOKEN]),
      `{"access_token":"${ACCESS_TOKEN}"`,
      'null',
    ]) {
      const transport = scripted([{ status: 200, headers: {}, body }]);
      await assert.rejects(tokenClient(transport).exchangeToken(FORM), (error: unknown) => {
        assert.ok(error instanceof ProviderHttpError, body);
        assert.equal(error.code, 'bad_response', body);
        assertEchoesNothing(error, [ACCESS_TOKEN, FORM.assertion]);
        return true;
      });
    }
  });

  it('retries a 5xx like any other call, then returns the token', async () => {
    const transport = scripted([
      { status: 503, headers: {}, body: `upstream ${ACCESS_TOKEN}` },
      ok({ access_token: ACCESS_TOKEN, token_type: 'bearer' }),
    ]);
    const grant = await tokenClient(transport).exchangeToken(FORM);
    assert.deepEqual(grant, {
      accessToken: ACCESS_TOKEN,
      expiresIn: null,
      refreshToken: null,
      scope: null,
    });
    assert.equal(transport.seen.length, 2);
  });

  it('an OAuth code grant returns the refresh token and the granted scopes', async () => {
    const refresh = '1//FAKE-refresh-token-0123456789abcdef';
    const transport = scripted([
      ok({
        access_token: ACCESS_TOKEN,
        expires_in: 3599,
        refresh_token: refresh,
        scope: 'openid email',
        token_type: 'Bearer',
      }),
    ]);
    const grant = await tokenClient(transport).exchangeToken({ grant_type: 'authorization_code' });
    assert.deepEqual(grant, {
      accessToken: ACCESS_TOKEN,
      expiresIn: 3599,
      refreshToken: refresh,
      scope: 'openid email',
    });
  });

  it('revokeToken POSTs the token, url-encoded, to exactly the revoke URL; a 400 is done', async () => {
    const token = '1//FAKE-refresh-token-0123456789abcdef';
    const revoker = (transport: Transport): ReadOnlyClient =>
      createReadOnlyClient({
        provider: 'google_calendar',
        transport,
        clock: fakeClock(),
        revokeUrl: GOOGLE_REVOKE_URL,
      });
    const transport = scripted([ok({})]);
    await revoker(transport).revokeToken(token);
    assert.deepEqual(transport.seen, [
      {
        method: 'POST',
        url: 'https://oauth2.googleapis.com/revoke',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ token }).toString(),
      },
    ]);
    // Already revoked or expired: nothing left to do.
    await revoker(
      scripted([{ status: 400, headers: {}, body: '{"error":"invalid_token"}' }]),
    ).revokeToken(token);
    await assert.rejects(
      revoker(scripted([{ status: 401, headers: {}, body: `no ${token}` }])).revokeToken(token),
      (error: unknown) => {
        assert.ok(error instanceof ProviderHttpError);
        assertEchoesNothing(error, [token]);
        return true;
      },
    );
    await assert.rejects(tokenClient(scripted([])).revokeToken(token), /not enabled/);
    assert.throws(
      () =>
        createReadOnlyClient({
          provider: 'google_calendar',
          transport: scripted([]),
          revokeUrl: 'https://oauth2.googleapis.com/revoke?x=1',
        }),
      /not allow-listed/,
    );
  });

  it('a redirect the transport refused is bad_response at once: not retried, so the form goes out once', async () => {
    const seen: HttpRequest[] = [];
    const transport: Transport = {
      send: (request) => {
        seen.push(request);
        return Promise.reject(new RedirectRefusedError());
      },
    };
    await assert.rejects(tokenClient(transport).exchangeToken(FORM), (error: unknown) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.deepEqual(sanitizeProviderError(error), {
        provider: 'google_drive',
        status: null,
        code: 'bad_response',
      });
      assertEchoesNothing(error, [FORM.assertion]);
      return true;
    });
    assert.equal(seen.length, 1);
  });

  it('in fixtures, a recorded POST answers the exchange; a missing one names only method and URL', async () => {
    const recorded = fixtureTransport([
      {
        request: { method: 'POST', url: GOOGLE_TOKEN_URL },
        response: { body: { access_token: ACCESS_TOKEN, token_type: 'Bearer' } },
      },
    ]);
    assert.equal((await tokenClient(recorded).exchangeToken(FORM)).accessToken, ACCESS_TOKEN);

    await assert.rejects(
      tokenClient(fixtureTransport([])).exchangeToken(FORM),
      (error: unknown) => {
        assert.ok(error instanceof FixtureMissingError);
        assert.equal(error.message, 'No fixture for POST https://oauth2.googleapis.com/token');
        assertEchoesNothing(error, [FORM.assertion]);
        return true;
      },
    );
  });
});

describe('errors', () => {
  it('redacts token-like query parameters from URLs', () => {
    const url =
      'https://moodle.example/webservice/rest/server.php?wstoken=FAKE123&wsfunction=core_x&moodlewsrestformat=json';
    const out = redactUrl(url);
    assert.equal(out.includes('FAKE123'), false);
    assert.match(out, /wsfunction=core_x/);
  });

  it('reduces any error to provider, status and code', () => {
    assert.deepEqual(
      sanitizeProviderError(new Error('socket hang up with Bearer FAKEabcdefghijklmnop'), 'jira'),
      {
        provider: 'jira',
        status: null,
        code: 'network',
      },
    );
  });
});

describe('grantedScope (H5: Linear may answer a string or an array)', () => {
  it('reads space or comma separated strings and arrays alike', async () => {
    const { grantedScope } = await import('./http.js');
    assert.equal(grantedScope('read issues:create'), 'read issues:create');
    assert.equal(grantedScope('read,issues:create'), 'read issues:create');
    assert.equal(grantedScope(['read', 'issues:create']), 'read issues:create');
    assert.equal(grantedScope([]), null);
    assert.equal(grantedScope(''), null);
    assert.equal(grantedScope(undefined), null);
  });
});
