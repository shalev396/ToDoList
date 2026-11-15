/**
 * A workspace's join link ("anyone with the link", A2) as an immutable value object: the role it
 * grants, the SHA-256 of its token (to find it) and the token sealed with the stage key, so the
 * owner can copy the link again while the database never holds the raw token.
 *
 * The same stage key as the credentials (stageKeyProvider), bound to the workspace: a blob copied
 * to another workspace's document does not open. The token is never logged; its buffer is zeroed
 * after use.
 */
import type { JoinLinkData } from '../../models/definitions/Workspace.js';
import { open, seal, type EncBlob } from '../../services/crypto/envelope.js';
import { stageKeyProvider } from '../../services/crypto/stageKeyProvider.js';
import { logger } from '../../services/logger.js';
import { hashInviteToken, newInviteToken } from '../../services/inviteTokens.js';

/** What the owner's Share dialog shows: the link's state and, while it is on, its raw token. */
export interface JoinLinkState {
  enabled: boolean;
  role: 'editor' | 'viewer' | null;
  /** The raw token (the client builds the link); owner only, never logged. */
  token: string | null;
}

/** A link a token was just drawn for: the value object to store, and the raw token to show once. */
export interface IssuedJoinLink {
  link: JoinLink;
  token: string;
}

function contextFor(workspaceId: string): {
  workspaceId: string;
  integrationId: string;
  provider: string;
} {
  return { workspaceId, integrationId: 'join-link', provider: 'workspace' };
}

export class JoinLink {
  /** The state of a workspace with no link: "Restricted". */
  static readonly OFF: Readonly<JoinLinkState> = Object.freeze({
    enabled: false,
    role: null,
    token: null,
  });

  readonly #data: Readonly<JoinLinkData>;

  private constructor(data: JoinLinkData) {
    this.#data = Object.freeze(structuredClone(data));
    Object.freeze(this);
  }

  /** The link as stored. */
  static from(data: JoinLinkData): JoinLink {
    return new JoinLink(data);
  }

  /** A new link with a fresh token, sealed for the workspace. */
  static async issue(workspaceId: string, role: 'editor' | 'viewer'): Promise<IssuedJoinLink> {
    const token = newInviteToken();
    const plaintext = Buffer.from(token, 'utf8');
    let enc: EncBlob;
    try {
      enc = await seal(plaintext, contextFor(workspaceId), stageKeyProvider());
    } finally {
      plaintext.fill(0);
    }
    const link = new JoinLink({
      role,
      tokenHash: hashInviteToken(token),
      enc,
      updatedAt: new Date(),
    });
    return { link, token };
  }

  get role(): 'editor' | 'viewer' {
    return this.#data.role;
  }

  /** Whether `tokenHash` is this link's token's hash. */
  matches(tokenHash: string): boolean {
    return this.#data.tokenHash === tokenHash;
  }

  /** The same link (and token) granting another role. */
  withRole(role: 'editor' | 'viewer'): JoinLink {
    return new JoinLink({ ...this.#data, role, updatedAt: new Date() });
  }

  /**
   * The state the owner sees: the link on, with its raw token. A sealed copy that can't be opened
   * (a replaced local key, say) leaves the link working for people who have it; the owner can't
   * copy it again until they reset it.
   */
  async state(workspaceId: string): Promise<JoinLinkState> {
    try {
      return { enabled: true, role: this.role, token: await this.#openToken(workspaceId) };
    } catch (error) {
      logger.error('A join link token could not be opened', error);
      return { enabled: true, role: this.role, token: null };
    }
  }

  async #openToken(workspaceId: string): Promise<string> {
    const plaintext = await open(
      this.#data.enc as EncBlob,
      contextFor(workspaceId),
      stageKeyProvider(),
    );
    try {
      return plaintext.toString('utf8');
    } finally {
      plaintext.fill(0);
    }
  }

  /** The state of a link just issued: its token is known, nothing to open. */
  static stateOf(issued: IssuedJoinLink): JoinLinkState {
    return { enabled: true, role: issued.link.role, token: issued.token };
  }

  toJSON(): JoinLinkData {
    return structuredClone(this.#data);
  }
}
