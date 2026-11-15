/**
 * The dashboard classes (docs/design/CLASSES.md §6): Dashboard (with its History and Layout),
 * View (with its Query), Persona, and the Operation each of them checks before reading. The
 * collaborators a dashboard composes (DashboardConnectors, BlockPreviews, DocCheck) are used
 * through it.
 */
export {
  Dashboard,
  type CreateDashboardInput,
  type CreatePreview,
  type DashboardListFilter,
  type DashboardOpsInput,
  type DashboardOpsResult,
  type DashboardPatchInput,
  type InstantiateDashboardInput,
  type PublishInput,
  type RevertInput,
  type SaveChange,
  type UndoInput,
} from './Dashboard.js';
export {
  History,
  HistoryTrail,
  type HistoryAuthor,
  type HistoryDiff,
  type HistoryHead,
  type HistoryRestore,
  type HistoryWrite,
} from './History.js';
export { Layout } from './Layout.js';
export { Operation } from './Operation.js';
export { Persona, type InstantiatePersonaInput, type PersonaPlan } from './Persona.js';
export { Query } from './Query.js';
export { View, type CreateViewInput, type UpdateViewInput } from './View.js';
