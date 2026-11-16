import { ROLE_RANK, ROLES, type Role as RoleName } from '../../types/domain.js';

/**
 * A member's role (value object): owner > editor > viewer. Immutable, one instance per role, so
 * roles compare by value and `atLeast` is the only ordering anyone needs.
 */
export class Role {
  static readonly viewer = new Role('viewer');
  static readonly editor = new Role('editor');
  static readonly owner = new Role('owner');

  readonly #name: RoleName;

  private constructor(name: RoleName) {
    this.#name = name;
    Object.freeze(this);
  }

  /**
   * The role by name (a Role is returned as it is). A name that is not a role (a stored value
   * outside ROLES) is a clear error, never a Role that breaks later.
   */
  static of(role: Role | RoleName): Role {
    if (role instanceof Role) return role;
    switch (role) {
      case 'owner':
        return Role.owner;
      case 'editor':
        return Role.editor;
      case 'viewer':
        return Role.viewer;
      default:
        throw new Error(`Unknown role: ${JSON.stringify(role)}`);
    }
  }

  /** The role a stored or received value names; null for anything else. */
  static parse(value: unknown): Role | null {
    return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
      ? Role.of(value as RoleName)
      : null;
  }

  get name(): RoleName {
    return this.#name;
  }

  /** At least as much as `other`: an owner is at least an editor, an editor at least a viewer. */
  atLeast(other: Role | RoleName): boolean {
    return ROLE_RANK[this.#name] >= ROLE_RANK[Role.of(other).#name];
  }

  equals(other: Role | RoleName): boolean {
    return Role.of(other) === this;
  }

  toString(): RoleName {
    return this.#name;
  }

  toJSON(): RoleName {
    return this.#name;
  }
}
