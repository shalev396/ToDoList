/**
 * Real network transport (qa/prod), with the SSRF guard on every connection (netGuard, BACKEND.md
 * §6):
 *
 * - URLs: the request's URL and every redirect hop must pass assertPublicHttpsUrl: https on a
 *   public host, never credentials in the URL. Loopback (also over http) only with `allowLocal`,
 *   which defaults to off: only a test turns it on, for its in-process provider stand-ins.
 * - Addresses: requests go through an undici Agent whose `connect.lookup` refuses a name when any
 *   address it resolves to is not public (isPublicIp). The check runs on the addresses the socket
 *   then connects to, so a name that was public when its URL was checked cannot rebind to a
 *   private one. With `allowLocal`, a loopback name (`localhost`) may resolve to loopback too.
 * - Redirects: only a GET follows them, by hand (`redirect: 'manual'`), at most MAX_REDIRECTS
 *   hops, each as a GET. Every Location is resolved against the current URL and checked as
 *   above. When a hop changes origin, the credential headers (Authorization, Cookie, API keys…)
 *   are dropped for the rest of the chain. Every other request (the token exchange, GraphQL) is
 *   sent with `redirect: 'error'`, so its body is never re-sent to another URL.
 * - Gives up after `timeoutMs` for the whole request, redirects included.
 *
 * Refusals are deterministic and never retried by the client: an unsafe URL or address throws
 * DestinationRefusedError (`network`), a redirect it will not follow RedirectRefusedError
 * (`bad_response`). Neither message names the URL or the address.
 */
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { isIPv6, type LookupFunction } from 'node:net';
import { Agent, fetch, type Response } from 'undici';

import { loopbackAllowedForTests } from '../../config/testSwitches.js';
import { assertPublicHttpsUrl, isLoopbackHost, isPublicIp } from '../../services/netGuard.js';
import { RedirectRefusedError } from '../errors.js';
import {
  DestinationRefusedError,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from '../http.js';

/** The most redirects a GET follows. */
export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Header names that may carry a credential (Authorization, Proxy-Authorization, Cookie, X-Api-Key,
 * Private-Token, X-Auth-Token…): none is sent on once a redirect leaves the request's origin.
 */
const CREDENTIAL_HEADER = /auth|cookie|token|key|secret|session|signature|credential|password/i;

export type RedirectNotFollowedReason = 'unsafe_location' | 'too_many_redirects';

const NOT_FOLLOWED_MESSAGES: Readonly<Record<RedirectNotFollowedReason, string>> = {
  unsafe_location: 'Refused to follow a redirect to a URL that is not a public https URL',
  too_many_redirects: `Refused to follow more than ${String(MAX_REDIRECTS)} redirects`,
};

/**
 * A GET redirect this transport will not follow: its Location is not a URL netGuard allows, or it
 * would be hop MAX_REDIRECTS + 1. A RedirectRefusedError, so the client fails at once as
 * `bad_response`. The message never repeats the Location.
 */
export class RedirectNotFollowedError extends RedirectRefusedError {
  readonly reason: RedirectNotFollowedReason;

  constructor(reason: RedirectNotFollowedReason) {
    super();
    this.name = 'RedirectNotFollowedError';
    this.message = NOT_FOLLOWED_MESSAGES[reason];
    this.reason = reason;
  }
}

/** A response body over `maxBodyBytes`: refused by its content-length, or cut off while read. */
export class ResponseTooLargeError extends Error {
  constructor() {
    super('The response body is larger than allowed');
    this.name = 'ResponseTooLargeError';
  }
}

export interface LiveTransportOptions {
  /**
   * The most body bytes to accept. Default: unlimited (the body is read whole). When set, a
   * larger content-length is refused at once, and a body is read as a stream and cancelled the
   * moment it passes the cap: a ResponseTooLargeError, never the whole body in memory.
   */
  maxBodyBytes?: number;
  /** For the whole request, redirects included (default 30 s). */
  timeoutMs?: number;
  /**
   * Loopback hosts too, over http or https. Default: only while a test allows them
   * (setLoopbackAllowedForTests); a server calls public https hosts only.
   */
  allowLocal?: boolean;
  /** Resolves names at connect time (default: dns.lookup). Tests inject a stand-in DNS. */
  lookup?: LookupFunction;
}

/**
 * `lookup`, refusing (DestinationRefusedError) a name when any address it resolves to is not
 * public (isPublicIp): a mixed answer is refused whole. With `allowLocal`, a loopback name may
 * resolve to loopback addresses (a test's stand-ins); a private address is never
 * admitted. Resolver errors (ENOTFOUND…) pass on unchanged. Answers in the shape asked: every
 * address (`all: true`) or the first.
 */
export function publicOnlyLookup(
  lookup: LookupFunction,
  options: { allowLocal: boolean },
): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    const loopbackName = options.allowLocal && isLoopbackHost(hostname);
    const allowed = (address: string): boolean =>
      isPublicIp(address) || (loopbackName && isLoopbackHost(address));
    lookup(hostname, { ...lookupOptions, all: true }, (error, resolved) => {
      if (error !== null) {
        callback(error, '');
        return;
      }
      const addresses: LookupAddress[] =
        typeof resolved === 'string'
          ? [{ address: resolved, family: isIPv6(resolved) ? 6 : 4 }]
          : resolved;
      const [first] = addresses;
      if (first === undefined || !addresses.every(({ address }) => allowed(address))) {
        callback(new DestinationRefusedError(), '');
        return;
      }
      if (lookupOptions.all === true) callback(null, addresses);
      else callback(null, first.address, first.family);
    });
  };
}

/**
 * undici's rejection when a response redirects and the request said `redirect: 'error'`:
 * `TypeError('fetch failed')` caused by `Error('unexpected redirect')`.
 */
function isRefusedRedirect(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const cause: unknown = error.cause;
  return cause instanceof Error && cause.message === 'unexpected redirect';
}

/** Whether the lookup refused the address: fetch wraps it as the cause of a TypeError. */
function isRefusedAddress(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof DestinationRefusedError) return true;
    current = current.cause;
  }
  return false;
}

/** The headers without any that may carry a credential. */
function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADER.test(name)),
  );
}

/** The body as text; with `maxBodyBytes`, streamed and counted, cancelled once over the cap. */
async function readBody(response: Response, maxBodyBytes: number | undefined): Promise<string> {
  if (maxBodyBytes === undefined) return response.text();
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    await response.body?.cancel();
    throw new ResponseTooLargeError();
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (chunk.done) break;
    const value = chunk.value ?? new Uint8Array();
    total += value.byteLength;
    if (total > maxBodyBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function toHttpResponse(
  response: Response,
  maxBodyBytes: number | undefined,
): Promise<HttpResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: response.status, headers, body: await readBody(response, maxBodyBytes) };
}

export function liveTransport(options: LiveTransportOptions = {}): Transport {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const allowLocal = options.allowLocal ?? loopbackAllowedForTests();
  const dispatcher = new Agent({
    connect: { lookup: publicOnlyLookup(options.lookup ?? dnsLookup, { allowLocal }) },
  });

  /** The request's own URL, when netGuard allows it. */
  function destination(url: string): URL {
    try {
      return assertPublicHttpsUrl(url, { allowLocal });
    } catch {
      throw new DestinationRefusedError();
    }
  }

  /** The next hop: `location` resolved against the current URL, when netGuard allows it. */
  function nextHop(location: string, current: URL): URL {
    try {
      return assertPublicHttpsUrl(new URL(location, current), { allowLocal });
    } catch {
      throw new RedirectNotFollowedError('unsafe_location');
    }
  }

  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      const follows = request.method === 'GET';
      const signal = AbortSignal.timeout(timeoutMs);
      let url = destination(request.url);
      let headers: Record<string, string> = { ...request.headers };
      for (let hops = 0; ; hops += 1) {
        let response: Response;
        try {
          response = await fetch(url.href, {
            method: request.method,
            headers,
            ...(request.body === undefined ? {} : { body: request.body }),
            redirect: follows ? 'manual' : 'error',
            signal,
            dispatcher,
          });
        } catch (error) {
          if (!follows && isRefusedRedirect(error)) throw new RedirectRefusedError();
          if (isRefusedAddress(error)) throw new DestinationRefusedError();
          throw error;
        }
        const location = follows ? response.headers.get('location') : null;
        if (!REDIRECT_STATUSES.has(response.status) || location === null) {
          return toHttpResponse(response, options.maxBodyBytes);
        }
        // Not read: the connection goes back to the pool.
        await response.body?.cancel();
        if (hops >= MAX_REDIRECTS) throw new RedirectNotFollowedError('too_many_redirects');
        const next = nextHop(location, url);
        if (next.origin !== url.origin) headers = withoutCredentials(headers);
        url = next;
      }
    },
  };
}
