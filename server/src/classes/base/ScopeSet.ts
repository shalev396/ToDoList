/**
 * A set of agent scopes (MCP.md §4), as an immutable value object: what an agent key or sign-in
 * grant holds, what a member's role permits (ROLE_SCOPES), what an endpoint honours
 * (READ_ONLY_SCOPES on /api/mcp/readonly). An agent's effective scopes are its grant's ∩ its
 * role's (`effective`), so a key never exceeds its user.
 *
 * Always in catalog order (AGENT_SCOPES) and without repeats, whatever it was made from; a name
 * outside the catalog is never in it. Two sets are equal when they hold the same scopes. Pure.
 */
import {
  AGENT_SCOPES,
  READ_ONLY_SCOPES,
  ROLE_SCOPES,
  type AgentScope,
  type Role as RoleName,
} from '../../types/domain.js';
import { Role } from './Role.js';

export class ScopeSet {
  /** The scopes that only read: all that /api/mcp/readonly honours. */
  static readonly readOnly: ScopeSet = new ScopeSet(READ_ONLY_SCOPES);

  readonly #scopes: readonly AgentScope[];

  private constructor(scopes: Iterable<string>) {
    const named = new Set<string>(scopes);
    this.#scopes = Object.freeze(AGENT_SCOPES.filter((scope) => named.has(scope)));
    Object.freeze(this);
  }

  /** The catalog's scopes among `scopes`, in catalog order (any other name is left out). */
  static of(scopes: Iterable<string>): ScopeSet {
    return new ScopeSet(scopes);
  }

  /** What a member with this role may use through a key (ROLE_SCOPES). */
  static forRole(role: Role | RoleName): ScopeSet {
    return new ScopeSet(ROLE_SCOPES[Role.of(role).name]);
  }

  /** An agent's effective scopes: those of its grant that its user's current role permits. */
  static effective(granted: Iterable<string>, role: Role | RoleName): ScopeSet {
    return ScopeSet.of(granted).intersect(ScopeSet.forRole(role));
  }

  get size(): number {
    return this.#scopes.length;
  }

  has(scope: string): boolean {
    return (this.#scopes as readonly string[]).includes(scope);
  }

  /** Whether it holds every one of `scopes` (none asked: true). */
  hasAll(scopes: Iterable<string>): boolean {
    for (const scope of scopes) if (!this.has(scope)) return false;
    return true;
  }

  /** The scopes in both. */
  intersect(other: ScopeSet): ScopeSet {
    return new ScopeSet(this.#scopes.filter((scope) => other.has(scope)));
  }

  /** What an endpoint honours of it: all of it, or only the read scopes on /readonly. */
  onEndpoint(options: { readonly: boolean }): ScopeSet {
    return options.readonly ? this.intersect(ScopeSet.readOnly) : this;
  }

  equals(other: ScopeSet): boolean {
    return (
      other.#scopes.length === this.#scopes.length &&
      other.#scopes.every((scope, index) => scope === this.#scopes[index])
    );
  }

  /** The scopes, in catalog order: a fresh array each time. */
  toArray(): AgentScope[] {
    return [...this.#scopes];
  }

  toJSON(): AgentScope[] {
    return this.toArray();
  }
}
