/**
 * The dashboard classes (docs/design/CLASSES.md §6): Dashboard (with its Layout; making one is
 * Dashboard.create, NewDashboard is not exported: it answers raw data),
 * View (with its Query), Persona, and the Operation each of them checks before reading. History
 * (DashboardVersions) is internal to Dashboard and NewDashboard: not exported here
 * (dashboardInternals.test.ts); its limits are in limits.ts. The collaborators a dashboard composes
 * (DashboardConnectors, BlockPreviews, DashboardDryRun, DocCheck) are used through it, and so are
 * the Block classes (blocks/), which DocCheck asks to check and lint each block.
 */
export {
  Dashboard,
  type DashboardListFilter,
  type DashboardOpsInput,
  type DashboardOpsResult,
  type DashboardPatchInput,
  type PublishInput,
  type RevertInput,
  type SaveChange,
  type UndoInput,
} from './Dashboard.js';
export type { DashboardOutline } from './DashboardOutline.js';
export { Layout } from './Layout.js';
export type {
  CreateDashboardInput,
  CreatePreview,
  InstantiateDashboardInput,
} from './NewDashboard.js';
export { Operation } from './Operation.js';
export { Persona, type InstantiatePersonaInput, type PersonaPlan } from './Persona.js';
export { Query } from './Query.js';
export { View, type CreateViewInput, type UpdateViewInput } from './View.js';
