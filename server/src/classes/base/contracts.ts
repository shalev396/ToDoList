/**
 * The capability contracts entities implement (`implements`), so code can ask for "something
 * auditable" or "something that expires" instead of a concrete class, and the compiler checks
 * that every implementing class provides the whole contract.
 */
import type { AuditScope } from '../AuditLog.js';
import type { AuditTarget } from './AuditTarget.js';
import type { Caller } from './Caller.js';

/** Lives in one workspace. */
export interface WorkspaceScoped {
  readonly workspaceId: string;
}

/** Can be the target of an audit entry. */
export interface Auditable {
  auditTarget(): AuditTarget;
}

/** Deleted by setting `deletedAt`; the purge removes it later. */
export interface SoftDeletable {
  readonly deletedAt: Date | null;
  readonly isDeleted: boolean;
}

/** Belongs to one member of its workspace. */
export interface Owned {
  readonly ownerUserId: string;
  isOwnedBy(userId: string): boolean;
}

/** Changed under optimistic concurrency: a write names the version it read. */
export interface Versioned {
  readonly version: number;
}

/** Stops working at `expiresAt` (null: never). */
export interface Expirable {
  readonly expiresAt: Date | null;
  isExpired(now: Date): boolean;
}

/**
 * Can be withdrawn. `by` is who withdraws it, as the audit log records them: a Caller is one, and
 * so is the scope a member's departure acts in (whoever ended the membership, who has no standing
 * of the member's own), e.g. an integration's grant revoked while its integrations disconnect.
 */
export interface Revocable {
  revoke(by: AuditScope): Promise<void>;
}

/** Has a public shape, the only one the API, the UI and MCP see. */
export interface Viewable<TView> {
  toView(caller?: Caller): TView;
}
