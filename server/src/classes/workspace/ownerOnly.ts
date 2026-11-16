/** The one owner rule of the workspace classes: only an owner manages the workspace. */
import type { Caller } from '../base/Caller.js';
import { WorkspacePolicy } from '../policies/WorkspacePolicy.js';

/** 403 "Only an owner can do this" unless the caller owns their workspace (WorkspacePolicy). */
export function assertOwner(caller: Caller): void {
  caller.authorize(WorkspacePolicy.instance, 'manage', { workspaceId: caller.workspaceId });
}
