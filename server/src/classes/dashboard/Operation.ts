/**
 * What an operation on a dashboard or a saved view needs of the caller's role, as an immutable
 * value object. It is checked before the thing is even read, so a role that may not do it learns
 * nothing about what exists: the 403 always comes before a 404, as it always has.
 */
import { ForbiddenError } from '../../errors/ForbiddenError.js';
import type { Role as RoleName } from '../../types/domain.js';
import type { Caller } from '../base/Caller.js';
import { Role } from '../base/Role.js';

export class Operation {
  readonly #role: Role;
  readonly #verb: string;

  private constructor(role: Role, verb: string) {
    this.#role = role;
    this.#verb = verb;
    Object.freeze(this);
  }

  /** At least `role`; the refusal names the verb ("Only an editor can edit dashboards"). */
  static of(role: RoleName, verb: string): Operation {
    return new Operation(Role.of(role), verb);
  }

  get role(): Role {
    return this.#role;
  }

  get verb(): string {
    return this.#verb;
  }

  /** 403 "Only an editor can <verb>" / "Only an owner can <verb>" unless the caller may. */
  assert(caller: Caller): void {
    caller.require(this.#role, ForbiddenError.roleMessage(this.#role.name, this.#verb));
  }

  equals(other: Operation | null | undefined): boolean {
    return (
      other !== null &&
      other !== undefined &&
      other.#role.equals(this.#role) &&
      other.#verb === this.#verb
    );
  }
}
