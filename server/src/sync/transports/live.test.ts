/**
 * The live transport's SSRF guard (netGuard) against two local servers, A and B: the request URL
 * and every GET redirect hop must be public https (loopback allowed only with `allowLocal`, as in
 * a test), credential headers never cross an origin, a GET follows at most 5 hops, a
 * POST follows none, and every address a name resolves to is checked at connect time.
 *
 * Names resolve through a test DNS (the injected `lookup`): `localhost` is loopback, a few
 * `*.provider.test` names answer loopback addresses, and nothing else resolves. A socket jail
 * fails any connection to an IP literal that is not loopback before a packet leaves, so even a
 * broken guard could not reach the network from these tests; the last test checks the jail was
 * never needed.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LookupAddress, LookupOptions } from 'node:dns';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { isIP, Socket, type AddressInfo, type LookupFunction } from 'node:net';

import { RedirectRefusedError } from '../errors.js';
import {
  createReadOnlyClient,
  DestinationRefusedError,
  GOOGLE_TOKEN_URL,
  ProviderHttpError,
  type Clock,
  type HttpRequest,
  type Transport,
} from '../http.js';
import {
  liveTransport,
  MAX_REDIRECTS,
  publicOnlyLookup,
  RedirectNotFollowedError,
  ResponseTooLargeError,
  type LiveTransportOptions,
} from './live.js';

/** IP literals the jail refused: none, as long as the transport refuses them first. */
const jailed: string[] = [];

/** The host a Socket#connect call is for (options object, or Node's normalized [options, cb]). */
function connectHost(args: unknown[]): string | null {
  let [first] = args;
  if (Array.isArray(first)) [first] = first as unknown[];
  if (typeof first !== 'object' || first === null) return null;
  const host = (first as { host?: unknown }).host;
  return typeof host === 'string' ? host.replace(/^\[|\]$/g, '') : null;
}

/**
 * Lets a socket connect to a name (only the test DNS resolves it, to loopback) or to a loopback
 * address; any other IP literal fails at once. Returns the release.
 */
function jailSockets(): () => void {
  const proto = Socket.prototype as unknown as { connect: (...args: unknown[]) => Socket };
  const original = proto.connect;
  proto.connect = function jailedConnect(this: Socket, ...args: unknown[]): Socket {
    const host = connectHost(args);
    const loopback = host !== null && (host === '::1' || host.startsWith('127.'));
    if (host !== null && isIP(host) !== 0 && !loopback) {
      jailed.push(host);
      process.nextTick(() => this.destroy(new Error('jailed: not a loopback address')));
      return this;
    }
    return original.apply(this, args);
  };
  return () => {
    proto.connect = original;
  };
}

let releaseJail: () => void = () => undefined;

/** What the local servers received, in order. */
interface Received {
  server: 'A' | 'B';
  method: string;
  path: string;
  body: string;
  headers: IncomingHttpHeaders;
}

const received: Received[] = [];
/**
 * `/to`'s allowlist: the Locations tests registered through `to()`, by id. A request only picks
 * one of them, so the servers never redirect to a URL they were sent.
 */
const redirectTargets = new Map<string, string>();
/** Bytes `/big/chunked` has written. */
let bigSent = 0;
let serverA: Server;
let serverB: Server;
let portA: number;
let portB: number;
let baseA: string;
let baseB: string;

/**
 * - `/redirect/<status>`: that redirect to `/target`;
 * - `/hops/<n>`: a 302 to `/hops/<n-1>`, until `/hops/0` answers;
 * - `/to?id=<n>[&status=<status>]`: a redirect (302 by default) to the Location `to()` registered
 *   as `<n>`, as is (an unknown id is a 404);
 * - `/deep/dir/rel`: a 302 to `../../target?from=rel` (relative);
 * - `/no-location`: a 302 without a Location;
 * - `/echo`: the request's headers;
 * - anything else: 200 JSON naming the path.
 */
function handler(server: 'A' | 'B'): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      const path = request.url ?? '';
      received.push({ server, method: request.method ?? '', path, body, headers: request.headers });
      const url = new URL(path, 'http://local.invalid');
      const redirect = /^\/redirect\/(\d{3})$/.exec(url.pathname);
      const hops = /^\/hops\/(\d+)$/.exec(url.pathname);
      if (redirect !== null) {
        response.writeHead(Number(redirect[1]), { location: '/target' });
        response.end('moved');
      } else if (hops !== null && Number(hops[1]) > 0) {
        response.writeHead(302, { location: `/hops/${String(Number(hops[1]) - 1)}` });
        response.end();
      } else if (url.pathname === '/to') {
        const status = Number(url.searchParams.get('status') ?? '302');
        const location = redirectTargets.get(url.searchParams.get('id') ?? '');
        if (location === undefined) response.writeHead(404);
        else response.writeHead(status, { location });
        response.end();
      } else if (url.pathname === '/deep/dir/rel') {
        response.writeHead(302, { location: '../../target?from=rel' });
        response.end();
      } else if (url.pathname === '/no-location') {
        response.writeHead(302);
        response.end();
      } else if (url.pathname === '/big/chunked') {
        // Endless 64 KiB chunks (up to 64 MiB), written only as the client reads.
        response.writeHead(200, { 'content-type': 'application/json' });
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        const pump = (): void => {
          while (bigSent < 64 * 1024 * 1024 && !response.destroyed) {
            bigSent += chunk.length;
            if (!response.write(chunk)) {
              response.once('drain', pump);
              return;
            }
          }
          response.end();
        };
        pump();
      } else if (url.pathname === '/big/length') {
        response.writeHead(200, { 'content-length': String(10 * 1024 * 1024) });
        response.write('{');
      } else if (url.pathname === '/echo') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ server, headers: request.headers }));
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: { path } }));
      }
    });
  };
}

function startServer(name: 'A' | 'B'): Promise<Server> {
  const created = createServer(handler(name));
  return new Promise((resolve) => {
    created.listen(0, '127.0.0.1', () => {
      resolve(created);
    });
  });
}

function portOf(listening: Server): number {
  return (listening.address() as AddressInfo).port;
}

/** The names each test DNS knows: hostname → addresses. Anything else is ENOTFOUND. */
type Zone = Record<string, string[]>;

/** Every name a test DNS was asked for, in order. */
const lookups: string[] = [];

/** A `dns.lookup` stand-in over `zone`: asynchronous, in the shape asked (one, or all). */
function testDns(zone: Zone): LookupFunction {
  return (hostname, options, callback) => {
    lookups.push(hostname);
    const addresses = zone[hostname.toLowerCase()];
    setImmediate(() => {
      if (addresses === undefined) {
        const error = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
          code: 'ENOTFOUND',
        });
        callback(error, '');
        return;
      }
      const list: LookupAddress[] = addresses.map((address) => ({
        address,
        family: isIP(address),
      }));
      const [first] = list;
      if (options.all === true || first === undefined) callback(null, list);
      else callback(null, first.address, first.family);
    });
  };
}

const LOCAL_ZONE: Zone = { localhost: ['127.0.0.1'] };

/** The live transport as a test builds it (loopback allowed), over the test DNS. */
function transport(options: LiveTransportOptions = {}, zone: Zone = LOCAL_ZONE): Transport {
  return liveTransport({ allowLocal: true, lookup: testDns(zone), ...options });
}

const instantClock: Clock = { now: () => Date.now(), sleep: () => Promise.resolve() };

const CREDENTIALS = {
  authorization: 'Bearer FAKE-token-0042',
  'proxy-authorization': 'Basic FAKE-proxy',
  cookie: 'session=FAKE-session',
  'x-api-key': 'FAKE-api-key',
  'private-token': 'FAKE-private-token',
  'x-auth-token': 'FAKE-auth-token',
};
const PLAIN = {
  accept: 'application/json',
  'user-agent': 'TodoList-sync',
  'x-github-api-version': '2022-11-28',
};

before(async () => {
  releaseJail = jailSockets();
  serverA = await startServer('A');
  serverB = await startServer('B');
  portA = portOf(serverA);
  portB = portOf(serverB);
  baseA = `http://127.0.0.1:${String(portA)}`;
  baseB = `http://127.0.0.1:${String(portB)}`;
});

after(() => {
  releaseJail();
  for (const server of [serverA, serverB]) {
    server.closeAllConnections();
    server.close();
  }
});

/** `/to` on `base`, redirecting to `location`, which it adds to the allowlist. */
function to(base: string, location: string, status = 302): string {
  const id = String(redirectTargets.size);
  redirectTargets.set(id, location);
  return `${base}/to?status=${String(status)}&id=${id}`;
}

const paths = (): string[] => received.map((request) => `${request.server} ${request.path}`);

async function getJson(
  live: Transport,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await live.send({ method: 'GET', url, headers });
  return { status: response.status, body: JSON.parse(response.body) as Record<string, unknown> };
}

function refusedRedirect(reason: RedirectNotFollowedError['reason']): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof RedirectNotFollowedError, String(error));
    assert.ok(error instanceof RedirectRefusedError, 'the client fails it at once');
    assert.equal(error.reason, reason);
    return true;
  };
}

describe('liveTransport: the request URL itself (netGuard)', () => {
  it('an unsafe URL is refused before anything connects: DestinationRefusedError', async () => {
    const cases: [string, boolean][] = [
      // Loopback is only for tests, however it is spelled.
      [`${baseA}/target`, false],
      [`https://localhost:${String(portA)}/target`, false],
      [`https://2130706433:${String(portA)}/target`, false],
      // Never, not even there.
      ['https://10.0.0.1/rest/api/3/myself', true],
      ['https://169.254.169.254/latest/meta-data/', true],
      ['https://[fd00::1]/x', true],
      ['https://[::ffff:0:a00:1]/x', true],
      ['https://metadata.google.internal/computeMetadata/v1/', true],
      ['http://provider.test/x', true],
      [`https://user:pw@localhost:${String(portA)}/target`, true],
      [`http://localhost..:${String(portA)}/target`, true],
      ['not a url', true],
    ];
    for (const [url, allowLocal] of cases) {
      for (const method of ['GET', 'POST'] as const) {
        received.length = 0;
        lookups.length = 0;
        await assert.rejects(
          transport({ allowLocal }).send({
            method,
            url,
            headers: CREDENTIALS,
            ...(method === 'POST' ? { body: '{}' } : {}),
          }),
          (error: unknown) => {
            assert.ok(
              error instanceof DestinationRefusedError,
              `${method} ${url}: ${String(error)}`,
            );
            assert.equal(String(error).includes(url), false);
            return true;
          },
        );
        assert.deepEqual(received, [], `${method} ${url}`);
        assert.deepEqual(lookups, [], `${method} ${url}: nothing was resolved`);
      }
    }
  });
});

describe('liveTransport: GET redirects, hop by hop (netGuard)', () => {
  it('follows 301, 302, 303, 307 and 308 as a GET, without a body', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      received.length = 0;
      const { status: answered, body } = await getJson(
        transport(),
        `${baseA}/redirect/${String(status)}`,
      );
      assert.deepEqual([answered, body], [200, { data: { path: '/target' } }], String(status));
      assert.deepEqual(
        received.map((request) => `${request.method} ${request.path} ${request.body}`),
        [`GET /redirect/${String(status)} `, 'GET /target '],
        String(status),
      );
    }
  });

  it(`follows at most ${String(MAX_REDIRECTS)} hops: a 6th redirect is refused and never requested`, async () => {
    assert.equal(MAX_REDIRECTS, 5);
    received.length = 0;
    const five = await getJson(transport(), `${baseA}/hops/5`);
    assert.deepEqual(five, { status: 200, body: { data: { path: '/hops/0' } } });
    assert.equal(received.length, 6, 'the request and 5 hops');

    received.length = 0;
    await assert.rejects(
      transport().send({ method: 'GET', url: `${baseA}/hops/6`, headers: {} }),
      refusedRedirect('too_many_redirects'),
    );
    assert.deepEqual(paths(), [
      'A /hops/6',
      'A /hops/5',
      'A /hops/4',
      'A /hops/3',
      'A /hops/2',
      'A /hops/1',
    ]);
  });

  it('through the client, too many hops is bad_response at once: the chain is not retried', async () => {
    received.length = 0;
    const client = createReadOnlyClient({
      provider: 'jira',
      transport: transport(),
      clock: instantClock,
    });
    await assert.rejects(
      client.getJson(`${baseA}/hops/9`),
      (error: unknown) => error instanceof ProviderHttpError && error.code === 'bad_response',
    );
    assert.equal(received.length, 6);
  });

  it('a hop to a private, metadata or loopback-looking address is refused before it connects', async () => {
    for (const location of [
      'https://10.0.0.1/x',
      'https://192.168.1.10/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://[fd00::1]/x',
      'https://[::ffff:0:a00:1]/x',
      'https://[::ffff:10.0.0.1]/x',
      // 10.0.0.1 and 169.254.169.254, spelled as numbers.
      'https://167772161/x',
      'https://0xA9FEA9FE/latest/meta-data/',
      'https://127.0.0.1../x',
      'https://localhost../x',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://printer.local/x',
    ]) {
      received.length = 0;
      lookups.length = 0;
      await assert.rejects(
        transport().send({ method: 'GET', url: to(baseA, location), headers: CREDENTIALS }),
        refusedRedirect('unsafe_location'),
        location,
      );
      assert.equal(received.length, 1, `${location}: only the redirecting request`);
      assert.deepEqual(lookups, [], `${location}: nothing was resolved`);
    }
  });

  it('a hop to http (on a public host), another scheme, credentials, or no URL at all is refused', async () => {
    for (const location of [
      'http://provider.test/x',
      'ftp://provider.test/x',
      'file:///etc/passwd',
      'https://user:pw@provider.test/x',
      'https://[::1',
      'http://[',
    ]) {
      received.length = 0;
      lookups.length = 0;
      await assert.rejects(
        transport().send({ method: 'GET', url: to(baseA, location), headers: {} }),
        refusedRedirect('unsafe_location'),
        location,
      );
      assert.equal(received.length, 1, location);
      assert.deepEqual(lookups, [], location);
    }
  });

  it('a cross-origin hop drops Authorization, Cookie and every other credential header', async () => {
    received.length = 0;
    const { body } = await getJson(transport(), to(baseA, `${baseB}/echo`), {
      ...CREDENTIALS,
      ...PLAIN,
    });
    assert.equal(body['server'], 'B');
    const headers = body['headers'] as Record<string, string>;
    for (const name of Object.keys(CREDENTIALS)) {
      assert.equal(headers[name], undefined, `${name} crossed the origin`);
    }
    for (const [name, value] of Object.entries(PLAIN)) assert.equal(headers[name], value, name);
    // The first request had them all.
    assert.equal(received[0]?.headers.authorization, CREDENTIALS.authorization);
  });

  it('a same-origin hop keeps them', async () => {
    const { body } = await getJson(transport(), to(baseA, '/echo'), { ...CREDENTIALS, ...PLAIN });
    const headers = body['headers'] as Record<string, string>;
    for (const [name, value] of Object.entries({ ...CREDENTIALS, ...PLAIN })) {
      assert.equal(headers[name], value, name);
    }
  });

  it('another host or port is another origin; once dropped, credentials never come back', async () => {
    // 127.0.0.1 → localhost (same port, another host): dropped.
    const { body: renamed } = await getJson(
      transport(),
      to(baseA, `http://localhost:${String(portA)}/echo`),
      CREDENTIALS,
    );
    assert.equal((renamed['headers'] as Record<string, string>)['authorization'], undefined);

    // A → B → back to A: still dropped.
    received.length = 0;
    const { body } = await getJson(transport(), to(baseA, to(baseB, `${baseA}/echo`)), {
      ...CREDENTIALS,
      ...PLAIN,
    });
    assert.equal(body['server'], 'A');
    const headers = body['headers'] as Record<string, string>;
    assert.equal(headers['authorization'], undefined);
    assert.equal(headers['cookie'], undefined);
    assert.equal(headers['accept'], PLAIN.accept);
    assert.deepEqual(
      received.map((request) => request.server),
      ['A', 'B', 'A'],
    );
  });

  it('resolves each Location against the current URL', async () => {
    received.length = 0;
    const { body } = await getJson(transport(), `${baseA}/deep/dir/rel`);
    assert.deepEqual(body, { data: { path: '/target?from=rel' } });
    assert.deepEqual(paths(), ['A /deep/dir/rel', 'A /target?from=rel']);
  });

  it('a redirect without a Location is the answer, as before', async () => {
    const response = await transport().send({
      method: 'GET',
      url: `${baseA}/no-location`,
      headers: {},
    });
    assert.equal(response.status, 302);
  });
});

describe('liveTransport: no redirect for anything but a GET', () => {
  it('never follows a redirect on a POST: refused, and the body goes to no other URL', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      received.length = 0;
      await assert.rejects(
        transport().send({
          method: 'POST',
          url: `${baseA}/redirect/${String(status)}`,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'assertion=FAKE-signed-assertion',
        }),
        (error: unknown) =>
          error instanceof RedirectRefusedError && !(error instanceof RedirectNotFollowedError),
        String(status),
      );
      assert.deepEqual(
        received.map((request) => [request.method, request.path, request.body]),
        [['POST', `/redirect/${String(status)}`, 'assertion=FAKE-signed-assertion']],
        String(status),
      );
    }
  });

  it('a POST that cannot connect is a plain network failure, not a refused redirect', async () => {
    const closed = await startServer('B');
    const port = portOf(closed);
    closed.close();
    await assert.rejects(
      transport().send({
        method: 'POST',
        url: `http://127.0.0.1:${String(port)}/graphql`,
        headers: {},
        body: '{}',
      }),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RedirectRefusedError) &&
        !(error instanceof DestinationRefusedError),
    );
  });

  it('through the client, a GraphQL POST that is redirected fails once (bad_response), never retried', async () => {
    received.length = 0;
    const client = createReadOnlyClient({
      provider: 'linear',
      transport: transport(),
      graphql: { endpoint: `${baseA}/redirect/307`, documents: { Viewer: 'query Viewer { a }' } },
    });
    await assert.rejects(
      client.graphql('Viewer', {}, { authorization: 'FAKE-key' }),
      (error: unknown) => error instanceof ProviderHttpError && error.code === 'bad_response',
    );
    assert.deepEqual(paths(), ['A /redirect/307']);
  });

  it('through the client, the token POST is never re-sent to a Location', async () => {
    received.length = 0;
    const live = transport();
    const seen: HttpRequest[] = [];
    // The token URL is fixed: this stand-in hands the client's request to server A, which answers 307.
    const toServerA: Transport = {
      send: (request) => {
        seen.push(request);
        return live.send({ ...request, url: `${baseA}/redirect/307` });
      },
    };
    const client = createReadOnlyClient({
      provider: 'google_calendar',
      transport: toServerA,
      clock: instantClock,
      tokenExchangeUrl: GOOGLE_TOKEN_URL,
    });
    await assert.rejects(
      client.exchangeToken({ grant_type: 'jwt-bearer', assertion: 'FAKE.assertion' }),
      (error: unknown) => error instanceof ProviderHttpError && error.code === 'bad_response',
    );
    assert.deepEqual(
      seen.map((request) => [request.method, request.url]),
      [['POST', GOOGLE_TOKEN_URL]],
      'sent once: not retried',
    );
    assert.deepEqual(
      received.map((request) => [request.method, request.path, request.body]),
      [['POST', '/redirect/307', 'grant_type=jwt-bearer&assertion=FAKE.assertion']],
      'never re-sent to the Location',
    );
  });
});

describe('liveTransport: every resolved address is checked at connect time (DNS rebinding)', () => {
  // Each name answers with loopback addresses only (the local servers), so a broken check could
  // never reach further. Private, metadata and mixed answers: publicOnlyLookup, below.
  it('a public-looking name that resolves to a non-public address is refused: nothing is sent', async () => {
    for (const addresses of [['127.0.0.1'], ['::1'], ['::ffff:127.0.0.1'], ['127.0.0.2', '::1']]) {
      for (const allowLocal of [false, true]) {
        received.length = 0;
        lookups.length = 0;
        const live = transport({ allowLocal }, { 'rebind.provider.test': addresses });
        await assert.rejects(
          live.send({
            method: 'GET',
            url: `https://rebind.provider.test:${String(portA)}/target`,
            headers: CREDENTIALS,
          }),
          (error: unknown) => {
            assert.ok(error instanceof DestinationRefusedError, String(error));
            for (const address of addresses) assert.equal(String(error).includes(address), false);
            return true;
          },
          `${addresses.join(',')} allowLocal=${String(allowLocal)}`,
        );
        assert.deepEqual(lookups, ['rebind.provider.test']);
        assert.deepEqual(received, []);
      }
    }
  });

  it('through the client: network at once, the name resolved once (no retries)', async () => {
    lookups.length = 0;
    const client = createReadOnlyClient({
      provider: 'jira',
      transport: transport({ allowLocal: false }, { 'site.provider.test': ['127.0.0.3'] }),
      clock: instantClock,
    });
    await assert.rejects(
      client.getJson('https://site.provider.test/rest/api/3/myself'),
      (error: unknown) => error instanceof ProviderHttpError && error.code === 'network',
    );
    assert.deepEqual(lookups, ['site.provider.test']);
  });

  it('a redirect hop to a name that resolves to a non-public address is refused at connect', async () => {
    received.length = 0;
    const live = transport({}, { ...LOCAL_ZONE, 'internal.provider.test': ['127.0.0.1'] });
    await assert.rejects(
      live.send({
        method: 'GET',
        url: to(baseA, `https://internal.provider.test:${String(portB)}/echo`),
        headers: {},
      }),
      DestinationRefusedError,
    );
    assert.deepEqual(
      received.map((request) => request.server),
      ['A'],
      'B never heard of it',
    );
  });

  it('with allowLocal, a loopback name connects through the lookup to loopback (the mocks)', async () => {
    received.length = 0;
    lookups.length = 0;
    const { status, body } = await getJson(transport(), `http://localhost:${String(portA)}/target`);
    assert.deepEqual([status, body], [200, { data: { path: '/target' } }]);
    assert.deepEqual(lookups, ['localhost']);
  });
});

describe('publicOnlyLookup', () => {
  interface Answer {
    error: NodeJS.ErrnoException | null;
    address: string | LookupAddress[];
    family: number | undefined;
  }

  function ask(lookup: LookupFunction, hostname: string, options: LookupOptions): Promise<Answer> {
    return new Promise((resolve) => {
      lookup(hostname, options, (error, address, family) => {
        resolve({ error, address, family });
      });
    });
  }

  it('passes public addresses on, in the shape asked: all of them, or the first', async () => {
    const lookup = publicOnlyLookup(
      testDns({ 'api.provider.test': ['2606:4700::1111', '8.8.8.8'] }),
      { allowLocal: false },
    );
    assert.deepEqual(await ask(lookup, 'api.provider.test', { all: true }), {
      error: null,
      address: [
        { address: '2606:4700::1111', family: 6 },
        { address: '8.8.8.8', family: 4 },
      ],
      family: undefined,
    });
    assert.deepEqual(await ask(lookup, 'api.provider.test', {}), {
      error: null,
      address: '2606:4700::1111',
      family: 6,
    });
  });

  it('refuses a name with any address that is not public', async () => {
    for (const addresses of [
      ['10.0.0.5'],
      ['8.8.8.8', '127.0.0.1'],
      ['::ffff:0:7f00:1'],
      ['64:ff9b::a9fe:a9fe'],
      ['0.0.0.0'],
    ]) {
      const lookup = publicOnlyLookup(testDns({ 'api.provider.test': addresses }), {
        allowLocal: true,
      });
      for (const options of [{ all: true }, {}]) {
        const { error } = await ask(lookup, 'api.provider.test', options);
        assert.ok(error instanceof DestinationRefusedError, addresses.join(','));
      }
    }
  });

  it('passes a resolver error on unchanged', async () => {
    const lookup = publicOnlyLookup(testDns({}), { allowLocal: false });
    const { error } = await ask(lookup, 'missing.provider.test', { all: true });
    assert.equal(error?.code, 'ENOTFOUND');
  });

  it('refuses an empty answer', async () => {
    const lookup = publicOnlyLookup(testDns({ 'empty.provider.test': [] }), {
      allowLocal: false,
    });
    const { error } = await ask(lookup, 'empty.provider.test', { all: true });
    assert.ok(error instanceof DestinationRefusedError);
  });

  it('loopback only for a loopback name, and only with allowLocal; a private address never', async () => {
    const zone: Zone = {
      localhost: ['127.0.0.1', '::1'],
      'evil.provider.test': ['127.0.0.1'],
      'mixed.localhost': ['127.0.0.1'],
    };
    const local = publicOnlyLookup(testDns(zone), { allowLocal: true });
    assert.equal((await ask(local, 'localhost', { all: true })).error, null);
    assert.equal((await ask(local, 'LOCALHOST', { all: true })).error, null);
    for (const hostname of ['evil.provider.test', 'mixed.localhost']) {
      const { error } = await ask(local, hostname, { all: true });
      assert.ok(error instanceof DestinationRefusedError, hostname);
    }
    const deployed = publicOnlyLookup(testDns(zone), { allowLocal: false });
    assert.ok(
      (await ask(deployed, 'localhost', { all: true })).error instanceof DestinationRefusedError,
    );
    const privateLoopback = publicOnlyLookup(testDns({ localhost: ['127.0.0.1', '10.0.0.1'] }), {
      allowLocal: true,
    });
    assert.ok(
      (await ask(privateLoopback, 'localhost', { all: true })).error instanceof
        DestinationRefusedError,
    );
  });
});

describe('liveTransport: maxBodyBytes', () => {
  const CAP = 64 * 1024;

  it('an over-cap chunked body is cut off without reading it all', async () => {
    bigSent = 0;
    await assert.rejects(
      transport({ maxBodyBytes: CAP }).send({
        method: 'GET',
        url: `${baseA}/big/chunked`,
        headers: {},
      }),
      ResponseTooLargeError,
    );
    assert.ok(bigSent < 16 * 1024 * 1024, `the server wrote ${String(bigSent)} bytes`);
  });

  it('an over-cap content-length is refused at once', async () => {
    await assert.rejects(
      transport({ maxBodyBytes: CAP }).send({
        method: 'GET',
        url: `${baseA}/big/length`,
        headers: {},
      }),
      ResponseTooLargeError,
    );
  });

  it('an under-cap body is unchanged, and without the option nothing is capped', async () => {
    const small = await transport({ maxBodyBytes: CAP }).send({
      method: 'GET',
      url: `${baseA}/small`,
      headers: {},
    });
    assert.equal(small.status, 200);
    assert.deepEqual(JSON.parse(small.body), { data: { path: '/small' } });
    const uncapped = await transport().send({ method: 'GET', url: `${baseA}/small`, headers: {} });
    assert.equal(uncapped.body, small.body);
  });
});

describe('the socket jail', () => {
  it('was never needed: the transport refused every non-loopback address before connecting', () => {
    assert.deepEqual(jailed, []);
  });

  it('does stop an IP literal that is not loopback, before a packet leaves', async () => {
    const socket = new Socket();
    const failed = new Promise<Error>((resolve) => {
      socket.once('error', resolve);
    });
    socket.connect({ host: '10.255.255.1', port: 9 });
    assert.match((await failed).message, /^jailed/);
    assert.deepEqual(jailed.splice(0), ['10.255.255.1']);
  });
});
