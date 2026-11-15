/**
 * The old dashboard, view and persona entry points (services/dashboards.ts, views.ts,
 * personas.ts), one line each over the classes, for the suites written against them: the call
 * shapes `(workspace, actor, id, input)` and the assertions stay the same. Each builds the Caller
 * the old service built (`Caller.fromContext(workspace, actor)`) and loads the dashboard with the
 * operation's role checked first, as the routes and MCP tools do.
 *
 * Import it dynamically, after the test database is up, like the modules it stands for.
 */
import type { LintMode } from '../builder/lint.js';
import type { ActorRef } from '../classes/base/Actor.js';
import { Caller, type WorkspaceContext } from '../classes/base/Caller.js';
import {
  Dashboard,
  Persona,
  View,
  type CreateDashboardInput,
  type CreatePreview,
  type CreateViewInput,
  type DashboardListFilter,
  type DashboardOpsInput,
  type DashboardOpsResult,
  type DashboardPatchInput,
  type InstantiateDashboardInput,
  type InstantiatePersonaInput,
  type PersonaPlan,
  type PublishInput,
  type RevertInput,
  type UndoInput,
  type UpdateViewInput,
} from '../classes/dashboard/index.js';
import type {
  DashboardCopy,
  DashboardDryRunResult,
  DashboardPublishResult,
  DashboardSummary,
  DashboardValidation,
  DashboardVersionView,
  DashboardView,
  DashboardWriteResult,
  IntegrationShare,
  PersonaInstantiateResult,
  SavedView,
} from '../types/dashboards.js';

/** Who acts: a person in the UI, or an agent key acting for that person. */
export type BuilderActor = ActorRef;

export type { DashboardOpsResult } from '../classes/dashboard/index.js';

export { KEEP_VERSIONS, MAX_UNDO_STEPS, SNAPSHOT_EVERY } from '../classes/dashboard/limits.js';

function callerOf(ws: WorkspaceContext, actor: ActorRef): Caller {
  return Caller.fromContext(ws, actor);
}

// ─── Dashboards ───────────────────────────────────────────────────────────────

export function createDashboard(
  ws: WorkspaceContext,
  actor: ActorRef,
  input: CreateDashboardInput,
): Promise<DashboardView> {
  return Dashboard.create(callerOf(ws, actor), input);
}

export function previewCreateDashboard(
  ws: WorkspaceContext,
  actor: ActorRef,
  input: CreateDashboardInput & { previewRows?: number | undefined },
): Promise<CreatePreview> {
  return Dashboard.previewCreate(callerOf(ws, actor), input);
}

export function instantiateDashboard(
  ws: WorkspaceContext,
  actor: ActorRef,
  input: InstantiateDashboardInput,
): Promise<DashboardView> {
  return Dashboard.instantiate(callerOf(ws, actor), input);
}

export function templateShares(
  ws: WorkspaceContext,
  actor: ActorRef,
  templateKeys: readonly string[],
): Promise<IntegrationShare[]> {
  return Dashboard.templateShares(callerOf(ws, actor), templateKeys);
}

export function validateDashboardDraft(
  ws: Pick<WorkspaceContext, 'id'>,
  draft: unknown,
  mode: LintMode,
): Promise<DashboardValidation> {
  return Dashboard.validateDraft(ws.id, draft, mode);
}

export async function getDashboard(
  ws: WorkspaceContext,
  actor: ActorRef,
  id: string,
  options: { as?: DashboardCopy | undefined },
): Promise<DashboardView> {
  const caller = callerOf(ws, actor);
  return (await Dashboard.load(caller, id)).view(caller, options);
}

export function listDashboards(
  ws: WorkspaceContext,
  actor: ActorRef,
  filter: DashboardListFilter,
): Promise<DashboardSummary[]> {
  return Dashboard.list(callerOf(ws, actor), filter);
}

export async function applyDashboardOps(
  ws: WorkspaceContext,
  actor: ActorRef,
  id: string,
  input: DashboardOpsInput,
): Promise<DashboardOpsResult> {
  const caller = callerOf(ws, actor);
  return (await Dashboard.load(caller, id, Dashboard.Operation.edit)).applyOps(caller, input);
}

export async function applyDashboardPatch(
  ws: WorkspaceContext,
  actor: ActorRef,
  id: string,
  input: DashboardPatchInput,
): Promise<DashboardOpsResult> {
  const caller = callerOf(ws, actor);
  return (await Dashboard.load(caller, id, Dashboard.Operation.edit)).applyPatch(caller, input);
}

export async function undoDashboard(
  ws: WorkspaceContext,
  actor: ActorRef,
  id: string,
  input: UndoInput,
): Promise<DashboardWriteResult> {
  const caller = callerOf(ws, actor);
  return (await Dashboard.load(caller, id, Dashboard.Operation.undo)).undo(caller, input);
}

export async function previewUndo(
  ws: WorkspaceContext,
  actor: ActorRef,
  id: string,
  input: UndoInput & { previewRows?: number | undefined },
): Promise<DashboardDryRunResult> {
  const caller = callerOf(ws, actor);
  return (await Dashboard.load(caller, id, Dashboard.Operation.undo)).previewUndo(caller, input);
}

export async function redoDashboard(
  ws: WorkspaceContext,
  actor: ActorRef,
  id: string,
  input: { expectedVersion: number },
): Promise<DashboardWriteResult> {
  const caller = callerOf(ws, actor);
  return (await Dashboard.load(caller, id, Dashboard.Operation.redo)).redo(caller, input);
}

export async function revertDashboard(
  ws: WorkspaceContext,
  actor: ActorRef,
  id: string,
  input: RevertInput,
): Promise<DashboardWriteResult> {
  const caller = callerOf(ws, actor);
  return (await Dashboard.load(caller, id, Dashboard.Operation.revert)).revert(caller, input);
}

export async function previewRevert(
  ws: WorkspaceContext,
  actor: ActorRef,
  id: string,
  input: RevertInput & { previewRows?: number | undefined },
): Promise<DashboardDryRunResult> {
  const caller = callerOf(ws, actor);
  return (await Dashboard.load(caller, id, Dashboard.Operation.revert)).previewRevert(
    caller,
    input,
  );
}

export async function publishDashboard(
  ws: WorkspaceContext,
  actor: ActorRef,
  id: string,
  input: PublishInput,
): Promise<DashboardPublishResult> {
  const caller = callerOf(ws, actor);
  return (await Dashboard.load(caller, id, Dashboard.Operation.publish)).publish(caller, input);
}

export async function deleteDashboard(
  ws: WorkspaceContext,
  actor: ActorRef,
  id: string,
): Promise<void> {
  const caller = callerOf(ws, actor);
  await (await Dashboard.load(caller, id, Dashboard.Operation.delete)).delete(caller);
}

export async function listDashboardVersions(
  ws: WorkspaceContext,
  actor: ActorRef,
  id: string,
  options: { limit?: number | undefined },
): Promise<DashboardVersionView[]> {
  const caller = callerOf(ws, actor);
  return (await Dashboard.load(caller, id, Dashboard.Operation.history)).versions(caller, options);
}

export function removeConnectorEverywhere(
  ws: WorkspaceContext,
  actor: ActorRef,
  integrationId: string,
): Promise<number> {
  return Dashboard.removeConnectorEverywhere(callerOf(ws, actor), integrationId);
}

// ─── Saved views ──────────────────────────────────────────────────────────────

export async function listViews(ws: WorkspaceContext, userId: string): Promise<SavedView[]> {
  return (await View.list(callerOf(ws, { userId, agentId: null }))).map((view) => view.toView());
}

export async function getView(
  ws: WorkspaceContext,
  userId: string,
  id: string,
): Promise<SavedView> {
  return (await View.load(callerOf(ws, { userId, agentId: null }), id)).toView();
}

export async function createView(
  ws: WorkspaceContext,
  actor: ActorRef,
  input: CreateViewInput,
): Promise<SavedView> {
  return (await View.create(callerOf(ws, actor), input)).toView();
}

export async function updateView(
  ws: WorkspaceContext,
  actor: ActorRef,
  id: string,
  input: UpdateViewInput,
): Promise<SavedView> {
  const caller = callerOf(ws, actor);
  return (await (await View.load(caller, id, View.Operation.edit)).update(caller, input)).toView();
}

export async function deleteView(ws: WorkspaceContext, actor: ActorRef, id: string): Promise<void> {
  const caller = callerOf(ws, actor);
  await (await View.load(caller, id, View.Operation.delete)).delete(caller);
}

// ─── Personas ─────────────────────────────────────────────────────────────────

export function planPersona(
  ws: WorkspaceContext,
  actor: ActorRef,
  input: InstantiatePersonaInput,
): Promise<PersonaPlan> {
  return Persona.plan(callerOf(ws, actor), input);
}

export function instantiatePersona(
  ws: WorkspaceContext,
  actor: ActorRef,
  input: InstantiatePersonaInput,
): Promise<PersonaInstantiateResult> {
  return Persona.instantiate(callerOf(ws, actor), input);
}
