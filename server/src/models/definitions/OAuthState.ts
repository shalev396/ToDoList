import type { Provider } from '../../types/domain.js';

/**
 * One OAuth authorization in flight (Google Calendar, INTEGRATIONS-SETUP.md §1): started by an
 * owner, finished by the provider's redirect to the public callback. Single use, bound to the user
 * and the workspace, and removed 10 minutes after `createdAt` (TTL; the callback checks the age
 * itself too, since the TTL monitor runs about once a minute).
 *
 * Nothing here leaves the server: the raw `state` and the browser nonce exist only in the browser
 * (as their SHA-256 here), and the PKCE verifier is read by the callback alone.
 */
export interface OAuthStateData {
  id: string;
  /** SHA-256 (hex) of the `state` sent to the provider. */
  stateHash: string;
  /** SHA-256 (hex) of the nonce in the browser's binding cookie. */
  browserHash: string;
  /** The PKCE code verifier (RFC 7636): server-only, sent once, to the token endpoint. */
  codeVerifier: string;
  userId: string;
  workspaceId: string;
  provider: Provider;
  /** The integration a reconnect started from, if any. */
  integrationId: string | null;
  /** The UI language the callback returns to (`/<lng>/integrations`). */
  lng: string;
  createdAt: Date;
  usedAt: Date | null;
}

export type CreateOAuthStateInput = Omit<OAuthStateData, 'id' | 'workspaceId' | 'usedAt'>;

export interface IOAuthStateRepository {
  create(workspaceId: string, input: CreateOAuthStateInput): Promise<OAuthStateData>;
  /** Global: the public callback knows the state only (its hash is the lookup key). */
  findByStateHash(stateHash: string): Promise<OAuthStateData | null>;
  /** Marks it used, once: false when it already was (a race or a replay). */
  claim(workspaceId: string, id: string, at: Date): Promise<boolean>;
}

export const OAUTH_STATE_TABLE_NAME = 'OAuthStates';
/** How long an authorization may take, start to callback. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
