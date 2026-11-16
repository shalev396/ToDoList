import { NotFoundError } from '../../errors/NotFoundError.js';
import type { AppError } from '../../errors/AppError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { Caller } from '../base/Caller.js';
import { BasePolicy } from './Policy.js';

/** What the policy reads of an integration. */
export type IntegrationFacts = Pick<IntegrationData, 'workspaceId' | 'ownerUserId'>;

/**
 * Integration ownership (PERMISSIONS-V2): an integration belongs to one member inside one
 * workspace. Only its owner reads its details (status, config, card, sync runs) or manages it (a
 * test, a sync, an edit, a disconnect, stop sharing), whatever their role (rulings 1, 2, 10,
 * 23c). For anyone else it does not exist: every refusal is 404, never 403, workspace owners
 * included. Once shared (attached to a block) the other members see its items: that is
 * ItemPolicy's rule, never a read of the integration itself.
 */
export class IntegrationPolicy extends BasePolicy<IntegrationFacts> {
  static readonly instance = new IntegrationPolicy();

  private constructor() {
    super();
  }

  /** The one ownership test: manage actions, connector adds on blocks, writes to providers. */
  static isOwn(integration: Pick<IntegrationData, 'ownerUserId'>, userId: string): boolean {
    return integration.ownerUserId === userId;
  }

  canRead(caller: Caller, integration: IntegrationFacts): boolean {
    return this.canManage(caller, integration);
  }

  canEdit(caller: Caller, integration: IntegrationFacts): boolean {
    return this.canManage(caller, integration);
  }

  canManage(caller: Caller, integration: IntegrationFacts): boolean {
    return (
      integration.workspaceId === caller.workspaceId &&
      IntegrationPolicy.isOwn(integration, caller.userId)
    );
  }

  override refusal(): AppError {
    return new NotFoundError();
  }
}
