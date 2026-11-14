/**
 * Connect links (MCP.md §5.2): what an agent hands the user instead of ever taking a secret. An
 * agent (integrations_start_connect) asks for one; the user opens it, signed in, on the
 * Integrations page, and types the secret there (write-only).
 *
 * - The link holds a random id (256 bits), the provider and the workspace id: never a secret of
 *   the workspace. Only the id's sha256 is stored, in the audit entry `integration.connect_link`
 *   (who asked, through which agent key, for which provider, until when).
 * - It lasts 10 minutes and is consumed once (ReplayNonces: a second use is a duplicate key).
 * - Only the user the agent acts for may consume it, and only while an editor or owner (members
 *   connect their own integrations, PERMISSIONS-V2): the page checks the signed-in user against
 *   the agent's principal (MCP elicitation, against phishing).
 */
import { randomBytes } from 'node:crypto';

import { environment } from '../config/environment.js';
import { AppError } from '../errors/AppError.js';
import { getReplayNonceRepository } from '../models/index.js';
import { CONNECTABLE_PROVIDERS, type ConnectableProvider } from '../types/integrations.js';
import { Actor } from '../classes/base/Actor.js';
import { AuditTarget } from '../classes/base/AuditTarget.js';
import { Caller } from '../classes/base/Caller.js';
import { AuditLog } from '../classes/AuditLog.js';
import type { WorkspaceContext } from './accessFilter.js';
import { sha256Hex } from './crypto/hashing.js';
import { assertProviderOpen } from './integrationConfig.js';
import type { IntegrationActor } from './integrations.js';

export const CONNECT_LINK_TTL_MS = 10 * 60 * 1000;
export const CONNECT_LINK_ACTION = 'integration.connect_link';
const CONSUMED_ACTION = 'integration.connect_link_used';
/** ReplayNonces keys by nonce alone: this prefix keeps connect links apart from hook nonces. */
const NONCE_PREFIX = 'connect-link:';
/** ReplayNonces' integrationId slot: a connect link belongs to no integration yet. */
const NONCE_SCOPE = 'connect-link';

export interface ConnectLink {
  provider: ConnectableProvider;
  connectUrl: string;
  expiresAt: Date;
}

export function hashConnectLink(rawLink: string): string {
  return sha256Hex(rawLink);
}

/** The client's Integrations page, opened on the provider's connect form. */
export function connectLinkUrl(
  workspaceId: string,
  provider: ConnectableProvider,
  rawLink: string,
  domainName: string = environment.domainName,
): string {
  const query = new URLSearchParams({ workspace: workspaceId, connect: provider, link: rawLink });
  return `https://${domainName}/en/integrations?${query.toString()}`;
}

/** Editor or owner: a new single-use link for the provider, valid for 10 minutes from `now`. */
export async function createConnectLink(
  ctx: WorkspaceContext,
  actor: IntegrationActor,
  provider: ConnectableProvider,
  now: Date,
): Promise<ConnectLink> {
  Caller.fromContext(ctx, actor).require('editor');
  assertProviderOpen(provider);
  const rawLink = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + CONNECT_LINK_TTL_MS);
  await AuditLog.record(
    { workspaceId: ctx.id, actor },
    CONNECT_LINK_ACTION,
    AuditTarget.workspace(ctx.id),
    { provider, linkHash: hashConnectLink(rawLink), expiresAt: expiresAt.toISOString() },
  );
  return { provider, connectUrl: connectLinkUrl(ctx.id, provider, rawLink), expiresAt };
}

function isConnectable(value: unknown): value is ConnectableProvider {
  return CONNECTABLE_PROVIDERS.some((provider) => provider === value);
}

/**
 * Editor or owner, signed in: uses the link up. 404 when it is unknown, expired or from another
 * workspace; 403 when it was made for another user; 410 when it was already used.
 */
export async function consumeConnectLink(
  ctx: WorkspaceContext,
  userId: string,
  rawLink: string,
  now: Date = new Date(),
  actor?: Actor,
): Promise<{ provider: ConnectableProvider; expiresAt: Date }> {
  Caller.fromContext(ctx, Actor.user(userId)).require('editor');
  const linkHash = hashConnectLink(rawLink);
  const entry = await AuditLog.findRecent(ctx.id, {
    action: CONNECT_LINK_ACTION,
    metaEquals: { linkHash },
    since: new Date(now.getTime() - CONNECT_LINK_TTL_MS),
  });
  const provider = entry?.meta['provider'];
  const expiresAt = new Date(String(entry?.meta['expiresAt']));
  if (entry === null || !isConnectable(provider) || !(expiresAt.getTime() > now.getTime())) {
    throw new AppError(404, 'This link is not valid or has expired');
  }
  if (entry.actorUserId !== userId) {
    throw new AppError(403, 'This link was made for another member: sign in as them to use it');
  }
  const fresh = await (
    await getReplayNonceRepository()
  ).insert(ctx.id, NONCE_SCOPE, `${NONCE_PREFIX}${linkHash}`, expiresAt);
  if (!fresh) throw new AppError(410, 'This link was already used');
  await AuditLog.record(
    {
      workspaceId: ctx.id,
      actor: Actor.user(userId, { ip: actor?.ip, userAgent: actor?.userAgent }),
    },
    CONSUMED_ACTION,
    AuditTarget.workspace(ctx.id),
    { provider, requestedByAgentId: entry.actorAgentId ?? '' },
  );
  return { provider, expiresAt };
}
