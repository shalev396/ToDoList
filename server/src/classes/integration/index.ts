/**
 * The integration classes (docs/design/CLASSES.md §3). Import them from here: loading this module
 * registers every provider class (IntegrationRegistry), so `Integration.from` and the statics that
 * load integrations return the provider's subclass.
 *
 * Credential is not exported: only Integration.ts opens a credential (vaultImports.test.ts), and
 * only the classes here reach a writer (writePaths.test.ts). Each provider class declares what it
 * is as one `static definition` (definitions/*); OAuthFlow is the one OAuth sign-in.
 */
export {
  CREDENTIAL_MISSING,
  Integration,
  type ConnectedIntegration,
  type IntegrationUpdate,
  type OAuthConnection,
  type ReadSession,
  type SyncRequestOutcome,
  type TestRateLimited,
  type WriteSession,
} from './Integration.js';
export { Mode } from './Mode.js';
export {
  IntegrationRegistry,
  type IntegrationFactory,
  type ProviderClass,
} from './IntegrationRegistry.js';
export {
  OAuthFlow,
  type OAuthCallback,
  type OAuthIntegrationClass,
  type OAuthStart,
  type OAuthStartInput,
} from './OAuthFlow.js';
export {
  DEFINITIONS,
  definitionOf,
  IntegrationDefinition,
  type PickerKind,
} from './definitions/index.js';
export {
  isAddedContentRemover,
  isCalendarProvider,
  isCreateFunnel,
  isResourcePicker,
  isRevocable,
  picksFrom,
  isTaskProvider,
  supportsApiKey,
  supportsOAuth,
  type AddedContentRemover,
  type AddedRemoval,
  type CalendarDryRun,
  type CreatedRecord,
  type CreateFields,
  type PlainEventBody,
  type WriteResult,
  type CalendarProvider,
  type CalendarPushRequest,
  type CreatedTask,
  type CreateFunnel,
  type CreateTaskRequest,
  type GoogleCalendarEntry,
  type PickerResource,
  type PickerResources,
  type ResourcePicker,
  type Revocable,
  type SupportsApiKey,
  type SupportsOAuth,
  type TaskProvider,
} from './capabilities.js';
export { AuthStrategy, type AuthKind, type SecretJson } from './auth/AuthStrategy.js';
export { OAuthAuth, type ProviderIdentity, type RefreshPolicy } from './auth/OAuthAuth.js';
export { ApiKeyAuth } from './auth/ApiKeyAuth.js';
export { ServiceAccountAuth } from './auth/ServiceAccountAuth.js';
export { TrackerIntegration } from './TrackerIntegration.js';
export { JiraIntegration } from './providers/JiraIntegration.js';
export { ClickUpIntegration } from './providers/ClickUpIntegration.js';
export { LinearIntegration } from './providers/LinearIntegration.js';
export { GitHubIntegration } from './providers/GitHubIntegration.js';
export { GoogleCalendarIntegration } from './providers/GoogleCalendarIntegration.js';
export { MoodleIntegration } from './providers/MoodleIntegration.js';
export { UnlistedIntegration } from './providers/UnlistedIntegration.js';
