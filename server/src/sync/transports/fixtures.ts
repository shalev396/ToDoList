/**
 * Replays recorded provider responses (local, dev, tests). Never touches the network.
 *
 * A fixture file holds one entry or an array of entries:
 *   { "request": { "method": "GET", "url": "https://api.example.com/items?state=open" },
 *     "response": { "status": 200, "headers": { "etag": "x" }, "body": { ... } } }
 *   { "request": { "graphql": "BoardItems", "variables": { "number": 7 } },
 *     "response": { "body": { "data": { ... } } } }
 *
 * REST matching: same method (default GET), origin and path. Every query parameter listed in the
 * fixture must equal the request's. Parameters the fixture leaves out (tokens, `since`, page size)
 * are ignored, and the fixture with the most listed parameters wins.
 * GraphQL matching: same operation name; every listed variable must equal the request's.
 * A request no fixture matches is refused with FixtureMissingError (never retried).
 *
 * Response bodies may use relative-date tokens (`"{{datetime:+2d@14:00}}"`, see fixtureDates.ts),
 * resolved against `options.now` (default: the current time) in `options.timeZone`
 * (default Asia/Jerusalem), so replayed demo data is always current.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { FixtureMissingError, redactUrl } from '../errors.js';
import { resolveFixtureDates } from './fixtureDates.js';
import type { HttpRequest, HttpResponse, Transport } from '../http.js';

export interface FixtureEntry {
  request: {
    method?: 'GET' | 'POST';
    url?: string;
    graphql?: string;
    variables?: Record<string, unknown>;
  };
  response: {
    status?: number;
    headers?: Record<string, string>;
    body: unknown;
  };
}

export interface FixtureTransport extends Transport {
  /** Every request seen, in order (spy for "only GET + allow-listed POST" assertions). */
  readonly calls: HttpRequest[];
}

/**
 * Same origin and path. A fixture recorded for the placeholder site (`https://example.invalid/<site>/…`)
 * stands for any customer site of that provider: a second Jira or Moodle site connected in fixtures
 * mode (many-to-one) matches it on the path after the placeholder's own prefix.
 */
function sameEndpoint(want: URL, got: URL): boolean {
  if (want.origin === got.origin && want.pathname === got.pathname) return true;
  if (want.hostname !== 'example.invalid' || got.hostname === 'example.invalid') return false;
  const [, , ...rest] = want.pathname.split('/');
  return got.pathname === `/${rest.join('/')}`;
}

function restScore(fixture: FixtureEntry['request'], request: HttpRequest): number | null {
  if (fixture.url === undefined || fixture.graphql !== undefined) return null;
  if ((fixture.method ?? 'GET') !== request.method) return null;
  const want = new URL(fixture.url);
  const got = new URL(request.url);
  if (!sameEndpoint(want, got)) return null;
  let score = 0;
  for (const [name, value] of want.searchParams) {
    if (got.searchParams.get(name) !== value) return null;
    score += 1;
  }
  return score;
}

function graphqlScore(fixture: FixtureEntry['request'], request: HttpRequest): number | null {
  if (fixture.graphql === undefined || fixture.graphql !== request.graphqlOperation) return null;
  let score = 0;
  for (const [name, value] of Object.entries(fixture.variables ?? {})) {
    if (!isDeepStrictEqual(request.variables?.[name], value)) return null;
    score += 1;
  }
  return score;
}

export interface FixtureTransportOptions {
  now?: Date;
  timeZone?: string;
}

export function fixtureTransport(
  entries: readonly FixtureEntry[],
  options: FixtureTransportOptions = {},
): FixtureTransport {
  const calls: HttpRequest[] = [];
  return {
    calls,
    send(request: HttpRequest): Promise<HttpResponse> {
      calls.push(request);
      let best: FixtureEntry | null = null;
      let bestScore = -1;
      for (const entry of entries) {
        const score =
          request.graphqlOperation !== undefined
            ? graphqlScore(entry.request, request)
            : restScore(entry.request, request);
        if (score !== null && score > bestScore) {
          best = entry;
          bestScore = score;
        }
      }
      if (best === null) {
        const what = request.graphqlOperation ?? `${request.method} ${redactUrl(request.url)}`;
        return Promise.reject(new FixtureMissingError(what));
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(best.response.headers ?? {}))
        headers[key.toLowerCase()] = value;
      return Promise.resolve({
        status: best.response.status ?? 200,
        headers,
        body: resolveFixtureDates(
          typeof best.response.body === 'string'
            ? best.response.body
            : JSON.stringify(best.response.body),
          options.now ?? new Date(),
          options.timeZone ?? 'Asia/Jerusalem',
        ),
      });
    },
  };
}

/** Loads every *.json file in a fixture-set folder (each file: one entry or an array). */
export async function loadFixtureSet(dir: string): Promise<FixtureEntry[]> {
  const entries: FixtureEntry[] = [];
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.json')).sort()) {
    const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as
      | FixtureEntry
      | FixtureEntry[];
    entries.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  return entries;
}
