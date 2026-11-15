/**
 * An MCP OAuth client: who is asking to sign a member in (RFC 7591, and client ID metadata
 * documents, draft-ietf-oauth-client-id-metadata-document).
 *
 * Two kinds, both public clients (no secret; PKCE protects the code):
 * - dynamic (`dcr`): `register` validates the metadata and stores it; `resolve` finds it by id and
 *   notes its use at most once an hour, so an unused one expires (30 days, TTL on `lastUsedAt`);
 * - metadata document (`cimd`): the client id is an https URL with a path. `resolve` fetches the
 *   document from it (public hosts only, through the SSRF-safe live transport; 5 s, 64 KiB), which
 *   must name itself by that URL. Nothing is stored: the answer is cached 10 minutes, 200 at most.
 *
 * Redirects: an https URI matches only exactly. A loopback URI (http on localhost, 127.0.0.1 or
 * [::1]) matches the registered one with any port, nothing else different (RFC 8252 §7.3). No
 * fragments, no other schemes, no credentials. The exact check is the defence against a stolen
 * code, so it compares strings, never a normalised URL.
 */
import { OAuthError } from '../../errors/OAuthError.js';
import type { McpClientData } from '../../models/definitions/McpClient.js';
import { getMcpClientRepository } from '../../models/index.js';
import { assertPublicHttpsUrl } from '../../services/netGuard.js';
import { liveTransport } from '../../sync/transports/live.js';
import type { ActorOrigin } from '../base/Actor.js';
import { Entity } from '../base/Entity.js';

const NAME_MAX = 100;
const REDIRECTS_MAX = 10;
const GRANT_TYPES: readonly string[] = ['authorization_code', 'refresh_token'];
const RESPONSE_TYPES: readonly string[] = ['code'];

const FETCH_TIMEOUT_MS = 5000;
const DOCUMENT_MAX_BYTES = 64 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** `http://<loopback host>[:port]<rest>`: the host exactly, a numeric port, the rest verbatim. */
const LOOPBACK_URI = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?((?:[/?][^#\s]*)?)$/;
/** Characters that never belong in a redirect URI: whitespace, control characters, backslash. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\s\u0000-\u001f\u007f\\]/;

interface LoopbackParts {
  host: string;
  rest: string;
}

function loopbackParts(uri: string): LoopbackParts | null {
  const match = LOOPBACK_URI.exec(uri);
  if (match === null) return null;
  const [, host, port, rest] = match;
  if (host === undefined || rest === undefined) return null;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  return { host, rest };
}

/** Whether `uri` may be registered: https with no credentials, or http on a loopback host. */
function isAcceptableRedirect(uri: string): boolean {
  if (uri.length > 2048 || uri.includes('#') || UNSAFE_CHARS.test(uri)) return false;
  if (loopbackParts(uri) !== null) return true;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    uri.startsWith('https://') &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.hostname !== ''
  );
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null;
}

interface ValidatedMetadata {
  clientName: string;
  redirectUris: string[];
}

/** The client's name and redirect URIs, or an OAuthError. Shared by registration and CIMD. */
function validateIdentity(metadata: Record<string, unknown>): ValidatedMetadata {
  const name = metadata['client_name'];
  if (typeof name !== 'string' || name.trim() === '' || name.length > NAME_MAX) {
    throw new OAuthError('invalid_client_metadata', 'client_name must be 1 to 100 characters');
  }
  const uris = stringList(metadata['redirect_uris']);
  if (uris === null || uris.length < 1 || uris.length > REDIRECTS_MAX) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list 1 to 10 URIs');
  }
  if (!uris.every(isAcceptableRedirect)) {
    throw new OAuthError(
      'invalid_redirect_uri',
      'redirect_uris must be https, or http on a loopback host, with no fragment',
    );
  }
  return { clientName: name.trim(), redirectUris: [...new Set(uris)] };
}

/** `value` absent, or a list inside `allowed`. */
function subsetOf(value: unknown, allowed: readonly string[]): boolean {
  if (value === undefined) return true;
  const list = stringList(value);
  return list?.every((v) => allowed.includes(v)) === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A CIMD client id: an https URL with a path, no fragment (the host is checked when it is fetched). */
function metadataUrl(clientId: string): URL | null {
  if (!clientId.startsWith('https://') || clientId.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  return url.pathname !== '/' && url.hash === '' && !clientId.includes('#') ? url : null;
}

type MetadataFetch = (url: URL) => Promise<unknown>;

/** The real fetch: GET through the SSRF-safe transport, 200 only, JSON, at most 64 KiB. */
const liveMetadataFetch: MetadataFetch = async (url) => {
  const response = await liveTransport({
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBodyBytes: DOCUMENT_MAX_BYTES,
  }).send({
    method: 'GET',
    url: url.href,
    headers: { accept: 'application/json' },
  });
  if (response.status !== 200) throw new Error('metadata document not available');
  if (Buffer.byteLength(response.body, 'utf8') > DOCUMENT_MAX_BYTES) {
    throw new Error('metadata document too large');
  }
  return JSON.parse(response.body) as unknown;
};

let metadataFetch: MetadataFetch = liveMetadataFetch;

/** Resolved CIMD clients by URL, oldest first (Map order). */
const cache = new Map<string, { client: McpClient; expiresAt: number }>();

function cached(url: string, now: number): McpClient | null {
  const entry = cache.get(url);
  if (entry === undefined) return null;
  if (entry.expiresAt <= now) {
    cache.delete(url);
    return null;
  }
  return entry.client;
}

function remember(url: string, client: McpClient, now: number): void {
  cache.delete(url);
  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
  cache.set(url, { client, expiresAt: now + CACHE_TTL_MS });
}

export class McpClient extends Entity<McpClientData> {
  private constructor(data: McpClientData) {
    super(data);
  }

  get name(): string {
    return this.data.clientName;
  }

  get redirectUris(): string[] {
    return [...this.data.redirectUris];
  }

  /** Whether `uri` is one of this client's redirect URIs (exact; a loopback port may differ). */
  allowsRedirect(uri: string): boolean {
    if (typeof uri !== 'string' || uri.includes('#') || UNSAFE_CHARS.test(uri)) return false;
    const asked = loopbackParts(uri);
    return this.data.redirectUris.some((registered) => {
      if (registered === uri) return true;
      if (asked === null) return false;
      const known = loopbackParts(registered);
      return known !== null && known.host === asked.host && known.rest === asked.rest;
    });
  }

  /** Registers a dynamic public client (RFC 7591). The origin is unused: nothing is audited yet. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for the audit trail to come
  static async register(metadata: unknown, _origin: ActorOrigin): Promise<McpClient> {
    if (!isRecord(metadata)) {
      throw new OAuthError('invalid_client_metadata', 'The registration must be a JSON object');
    }
    const identity = validateIdentity(metadata);
    const method = metadata['token_endpoint_auth_method'];
    if (method !== undefined && method !== 'none') {
      throw new OAuthError('invalid_client_metadata', 'Only public clients (none) are supported');
    }
    if (!subsetOf(metadata['grant_types'], GRANT_TYPES)) {
      throw new OAuthError('invalid_client_metadata', 'Unsupported grant_types');
    }
    if (!subsetOf(metadata['response_types'], RESPONSE_TYPES)) {
      throw new OAuthError('invalid_client_metadata', 'Unsupported response_types');
    }
    const repository = await getMcpClientRepository();
    return new McpClient(await repository.create(identity));
  }

  /** The client behind a client_id: a metadata document URL, or a registered client's id. */
  static async resolve(clientId: string): Promise<McpClient> {
    if (typeof clientId !== 'string' || clientId === '' || clientId.length > 2048) {
      throw new OAuthError('invalid_client');
    }
    if (clientId.startsWith('https://')) return McpClient.#resolveDocument(clientId);
    const repository = await getMcpClientRepository();
    const found = await repository.findById(clientId);
    if (found === null) throw new OAuthError('invalid_client');
    const now = new Date();
    if (now.getTime() - found.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      await repository.touch(found.id, now);
    }
    return new McpClient(found);
  }

  static async #resolveDocument(clientId: string): Promise<McpClient> {
    const url = metadataUrl(clientId);
    if (url === null) throw new OAuthError('invalid_client');
    const hit = cached(clientId, Date.now());
    if (hit !== null) return hit;
    try {
      assertPublicHttpsUrl(url, { allowLocal: false });
      const document = await metadataFetch(url);
      if (!isRecord(document) || document['client_id'] !== clientId) {
        throw new OAuthError('invalid_client');
      }
      const identity = validateIdentity(document);
      const now = new Date();
      const client = new McpClient({
        id: clientId,
        clientName: identity.clientName,
        redirectUris: identity.redirectUris,
        source: 'cimd',
        lastUsedAt: now,
        createdAt: now,
      });
      remember(clientId, client, Date.now());
      return client;
    } catch {
      // Whatever went wrong (unsafe URL, network, size, JSON, rules): one answer, no detail.
      throw new OAuthError('invalid_client');
    }
  }

  /**
   * Tests only: what stands in for the metadata document fetch; null restores the real one. It
   * throws outside node:test, and drops the cache either way.
   */
  static setMetadataFetchForTests(fetcher: MetadataFetch | null): void {
    if ((process.env['NODE_TEST_CONTEXT'] ?? '') === '') {
      throw new Error('setMetadataFetchForTests runs only under node:test');
    }
    metadataFetch = fetcher ?? liveMetadataFetch;
    cache.clear();
  }
}
