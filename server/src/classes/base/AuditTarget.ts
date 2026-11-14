/**
 * What an audit entry is about (value object): a type and an id, e.g. `integration` + its id.
 * Immutable and compared by value. Only resolved ids go in, never raw input.
 */
export class AuditTarget {
  readonly #type: string;
  readonly #id: string;

  private constructor(type: string, id: string) {
    this.#type = type;
    this.#id = id;
    Object.freeze(this);
  }

  static of(type: string, id: string): AuditTarget {
    return new AuditTarget(type, id);
  }

  /** A plain `{type, id}` (an MCP tool's target) as a target; a target is returned as it is. */
  static from(target: AuditTarget | { readonly type: string; readonly id: string }): AuditTarget {
    return target instanceof AuditTarget ? target : new AuditTarget(target.type, target.id);
  }

  static workspace(workspaceId: string): AuditTarget {
    return new AuditTarget('workspace', workspaceId);
  }

  static integration(integrationId: string): AuditTarget {
    return new AuditTarget('integration', integrationId);
  }

  get type(): string {
    return this.#type;
  }

  get id(): string {
    return this.#id;
  }

  equals(other: AuditTarget): boolean {
    return other.#type === this.#type && other.#id === this.#id;
  }

  toJSON(): { type: string; id: string } {
    return { type: this.#type, id: this.#id };
  }
}
