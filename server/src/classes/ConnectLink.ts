/**
 * Connect links (MCP.md §5.2): what an agent hands the user instead of ever taking a secret. An
 * agent (integrations_start_connect) asks for one; the user opens it, signed in, on the
 * Integrations page, and types the secret there (write-only). The only code that writes
 * ReplayNonces for them.
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
import { sha256Hex } from '../services/crypto/hashing.js';
import { assertProviderOpen } from '../services/integrationConfig.js';
import { CONNECTABLE_PROVIDERS, type ConnectableProvider } from '../types/integrations.js';
import { Actor } from './base/Actor.js';
import { AuditTarget } from './base/AuditTarget.js';
import type { Caller } from './base/Caller.js';
import type { Expirable, Viewable } from './base/contracts.js';
import { AuditLog } from './AuditLog.js';

/** ReplayNonces keys by nonce alone: this prefix keeps connect links apart from hook nonces. */
const NONCE_PREFIX = 'connect-link:';
/** ReplayNonces' integrationId slot: a connect link belongs to no integration yet. */
const NONCE_SCOPE = 'connect-link';

/** A new link, as the agent gets it. */
export interface ConnectLinkView {
  provider: ConnectableProvider;
  connectUrl: string;
  expiresAt: Date;
}

/** What a used link was for. */
export interface UsedConnectLink {
  provider: ConnectableProvider;
  expiresAt: Date;
}

function isConnectable(value: unknown): value is ConnectableProvider {
  return CONNECTABLE_PROVIDERS.some((provider) => provider === value);
}

export class ConnectLink implements Expirable, Viewable<ConnectLinkView> {
  static readonly TTL_MS = 10 * 60 * 1000;

  /** The audit action names of a link's life. */
  static readonly Audit = Object.freeze({
    created: 'integration.connect_link',
    used: 'integration.connect_link_used',
  });

  readonly #provider: ConnectableProvider;
  readonly #connectUrl: string;
  readonly #expiresAt: Date;

  private constructor(provider: ConnectableProvider, connectUrl: string, expiresAt: Date) {
    this.#provider = provider;
    this.#connectUrl = connectUrl;
    this.#expiresAt = new Date(expiresAt.getTime());
    Object.freeze(this);
  }

  /** What is stored of a link: the sha256 of its random id. */
  static hash(rawLink: string): string {
    return sha256Hex(rawLink);
  }

  /** The client's Integrations page, opened on the provider's connect form. */
  static urlOf(
    workspaceId: string,
    provider: ConnectableProvider,
    rawLink: string,
    domainName: string = environment.domainName,
  ): string {
    const query = new URLSearchParams({ workspace: workspaceId, connect: provider, link: rawLink });
    return `https://${domainName}/en/integrations?${query.toString()}`;
  }

  /** Editor or owner: a new single-use link for the provider, valid for 10 minutes from `now`. */
  static async create(
    caller: Caller,
    provider: ConnectableProvider,
    now: Date,
  ): Promise<ConnectLink> {
    caller.require('editor');
    assertProviderOpen(provider);
    const rawLink = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + ConnectLink.TTL_MS);
    await AuditLog.record(
      caller,
      ConnectLink.Audit.created,
      AuditTarget.workspace(caller.workspaceId),
      { provider, linkHash: ConnectLink.hash(rawLink), expiresAt: expiresAt.toISOString() },
    );
    return new ConnectLink(
      provider,
      ConnectLink.urlOf(caller.workspaceId, provider, rawLink),
      expiresAt,
    );
  }

  /**
   * Editor or owner, signed in: uses the link up, once. 404 when it is unknown, expired or from
   * another workspace; 403 when it was made for another user; 410 when it was already used.
   */
  static async consume(
    caller: Caller,
    rawLink: string,
    now: Date = new Date(),
  ): Promise<UsedConnectLink> {
    caller.require('editor');
    const linkHash = ConnectLink.hash(rawLink);
    const entry = await AuditLog.findRecent(caller.workspaceId, {
      action: ConnectLink.Audit.created,
      metaEquals: { linkHash },
      since: new Date(now.getTime() - ConnectLink.TTL_MS),
    });
    const provider = entry?.meta['provider'];
    const expiresAt = new Date(String(entry?.meta['expiresAt']));
    if (entry === null || !isConnectable(provider) || !(expiresAt.getTime() > now.getTime())) {
      throw new AppError(404, 'This link is not valid or has expired');
    }
    if (entry.actorUserId !== caller.userId) {
      throw new AppError(403, 'This link was made for another member: sign in as them to use it');
    }
    const fresh = await (
      await getReplayNonceRepository()
    ).insert(caller.workspaceId, NONCE_SCOPE, `${NONCE_PREFIX}${linkHash}`, expiresAt);
    if (!fresh) throw new AppError(410, 'This link was already used');
    // A person uses it, signed in: never as an agent.
    const { ip, userAgent } = caller.actor;
    await AuditLog.record(
      { workspaceId: caller.workspaceId, actor: Actor.user(caller.userId, { ip, userAgent }) },
      ConnectLink.Audit.used,
      AuditTarget.workspace(caller.workspaceId),
      { provider, requestedByAgentId: entry.actorAgentId ?? '' },
    );
    return { provider, expiresAt };
  }

  get provider(): ConnectableProvider {
    return this.#provider;
  }

  /** For the user to open, signed in; single use. */
  get connectUrl(): string {
    return this.#connectUrl;
  }

  get expiresAt(): Date {
    return new Date(this.#expiresAt.getTime());
  }

  isExpired(now: Date): boolean {
    return now.getTime() >= this.#expiresAt.getTime();
  }

  toView(): ConnectLinkView {
    return { provider: this.#provider, connectUrl: this.#connectUrl, expiresAt: this.expiresAt };
  }
}
