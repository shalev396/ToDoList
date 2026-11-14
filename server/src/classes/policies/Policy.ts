/**
 * Permission rules as objects (PERMISSIONS-V2): one policy per kind of thing, each deciding read,
 * edit and manage for a caller, and naming the refusal a denied action answers. Callers ask
 * through `caller.authorize(policy, action, entity)`; the rules live only in the policies.
 */
import type { AppError } from '../../errors/AppError.js';
import { ForbiddenError } from '../../errors/ForbiddenError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import type { Caller } from '../base/Caller.js';

export const POLICY_ACTIONS = ['read', 'edit', 'manage'] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export interface Policy<TEntity> {
  canRead(caller: Caller, entity: TEntity): boolean;
  canEdit(caller: Caller, entity: TEntity): boolean;
  canManage(caller: Caller, entity: TEntity): boolean;
  /** What a denied `action` answers: 404 when the caller may not even know the entity exists. */
  refusal(caller: Caller, action: PolicyAction, entity: TEntity): AppError;
}

/**
 * The shared shape of the policies: subclasses supply the three decisions, and the default
 * refusal is 404 for what the caller can't read, else the role refusal the API has always
 * answered ("Only an editor can do this", "Only an owner can do this").
 */
export abstract class BasePolicy<TEntity> implements Policy<TEntity> {
  abstract canRead(caller: Caller, entity: TEntity): boolean;
  abstract canEdit(caller: Caller, entity: TEntity): boolean;
  abstract canManage(caller: Caller, entity: TEntity): boolean;

  refusal(caller: Caller, action: PolicyAction, entity: TEntity): AppError {
    if (action === 'read' || !this.canRead(caller, entity)) return new NotFoundError();
    return ForbiddenError.forRole(action === 'manage' ? 'owner' : 'editor');
  }
}
