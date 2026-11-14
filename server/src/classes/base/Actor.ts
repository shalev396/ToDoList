/**
 * Who acts (DATA.md §3.10): a person in the app, an agent key through MCP (on behalf of its user),
 * or the system (jobs, the sync). It also carries where the request came from, the address and
 * the user agent the audit log records, cut to a bounded length.
 */
import { redactString } from '../../services/secretPatterns.js';

export type ActorKind = 'user' | 'agent' | 'system';

/** Where a request came from. */
export interface ActorOrigin {
  readonly ip?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
}

/**
 * Who acts, as the services take it: an Actor is one, and so is a plain `{userId, agentId}` (a
 * test, a job). `agentId` is the agent key behind an MCP call, null for the app and the system.
 */
export interface ActorRef {
  readonly userId: string;
  readonly agentId: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/** What `Actor.originOf` reads of a request (an Express request is one). */
export interface RequestOrigin {
  readonly ip?: string | undefined;
  readonly headers: { readonly 'user-agent'?: string | undefined };
}

/**
 * Control characters never reach the log, secret-shaped text is redacted (the user agent is
 * client-controlled, and the audit log never holds a secret), and long values are cut.
 */
function bounded(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  let printable = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x20 && code !== 0x7f) printable += value.charAt(index);
  }
  const clean = redactString(printable).trim();
  return clean === '' ? null : clean.slice(0, max);
}

export class Actor implements ActorRef {
  /** The `actorUserId` of what the system does. */
  static readonly SYSTEM_USER_ID = 'system';
  /** An IPv6 address with a zone fits; anything longer is not an address. */
  static readonly IP_MAX = 64;
  static readonly USER_AGENT_MAX = 256;

  static readonly #system = new Actor('system', Actor.SYSTEM_USER_ID, null, {});

  readonly #kind: ActorKind;
  readonly #userId: string;
  readonly #agentId: string | null;
  readonly #ip: string | null;
  readonly #userAgent: string | null;

  private constructor(
    kind: ActorKind,
    userId: string,
    agentId: string | null,
    origin: ActorOrigin,
  ) {
    this.#kind = kind;
    this.#userId = userId;
    this.#agentId = agentId;
    this.#ip = bounded(origin.ip, Actor.IP_MAX);
    this.#userAgent = bounded(origin.userAgent, Actor.USER_AGENT_MAX);
    Object.freeze(this);
  }

  /** A person, in the app. */
  static user(userId: string, origin: ActorOrigin = {}): Actor {
    return new Actor('user', userId, null, origin);
  }

  /** An agent key, acting for its user. */
  static agent(userId: string, agentId: string, origin: ActorOrigin = {}): Actor {
    return new Actor('agent', userId, agentId, origin);
  }

  /** The system: jobs, the sync, a calendar push run. */
  static system(): Actor {
    return Actor.#system;
  }

  /** An Actor as it is; a plain `{userId, agentId}` as the user, agent or system it names. */
  static from(ref: ActorRef): Actor {
    if (ref instanceof Actor) return ref;
    const origin = { ip: ref.ip, userAgent: ref.userAgent };
    if (typeof ref.agentId === 'string') return new Actor('agent', ref.userId, ref.agentId, origin);
    if (ref.userId === Actor.SYSTEM_USER_ID) return new Actor('system', ref.userId, null, origin);
    return new Actor('user', ref.userId, null, origin);
  }

  /** The address and user agent of a request. */
  static originOf(request: RequestOrigin): ActorOrigin {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  get kind(): ActorKind {
    return this.#kind;
  }

  get userId(): string {
    return this.#userId;
  }

  get agentId(): string | null {
    return this.#agentId;
  }

  get ip(): string | null {
    return this.#ip;
  }

  get userAgent(): string | null {
    return this.#userAgent;
  }

  get isSystem(): boolean {
    return this.#kind === 'system';
  }

  /** As a change records who made it (`updatedBy`): the user and the agent key, never the origin. */
  toJSON(): { userId: string; agentId: string | null } {
    return { userId: this.#userId, agentId: this.#agentId };
  }
}
