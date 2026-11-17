import { NotFoundError } from '../../errors/NotFoundError.js';
import type { Caller } from './Caller.js';
import type { WorkspaceScoped } from './contracts.js';
import { Entity } from './Entity.js';

/**
 * An entity that lives inside one workspace (DATA.md §5): almost everything but users. A caller
 * from another workspace may not even learn it exists, so `assertIn` answers the same 404 as an id
 * that never existed.
 */
export abstract class WorkspaceEntity<TData extends { id: string; workspaceId: string }>
  extends Entity<TData>
  implements WorkspaceScoped
{
  get workspaceId(): string {
    return this.data.workspaceId;
  }

  /** 404 unless the caller acts in this entity's workspace. */
  protected assertIn(caller: Caller): void {
    if (caller.workspaceId !== this.workspaceId) throw new NotFoundError();
  }
}
