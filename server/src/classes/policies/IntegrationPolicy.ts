import { NotFoundError } from '../../errors/NotFoundError.js';
import type { AppError } from '../../errors/AppError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { Caller } from '../base/Caller.js';
import { BasePolicy } from './Policy.js';

/** What the policy reads of an integration; `shared`: a connector on some block (share-on-attach). */
export type IntegrationFacts = Pick<IntegrationData, 'workspaceId' | 'ownerUserId'> & {
  readonly shared?: boolean;
};

/**
 * Integration ownership (PERMISSIONS-V2): an integration belongs to one member inside one
 * workspace. Only its owner manages it (the config, a test, a sync, an edit, a disconnect, its
 * sync runs, stop sharing), whatever their role (rulings 1, 2, 10, 23c). Once shared (attached to
 * a block) the other members read its items, never its details. For anyone else it does not
 * exist: every refusal is 404, never 403, workspace owners included.
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
    return (
      integration.workspaceId === caller.workspaceId &&
      (IntegrationPolicy.isOwn(integration, caller.userId) || integration.shared === true)
    );
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
