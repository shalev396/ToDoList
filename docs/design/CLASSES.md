# Classes: the object model of the server

The server's domain is a set of classes (`server/src/classes/`). A class wraps 0..n models through
the `get…Repository()` getters and is the **only** code that touches the database; routes,
controllers and MCP tools stay thin functions (parse input → call a class → `toView()`), and pure
helpers (zod schemas, the builder's compiler, `gcal/diff`, the HTTP client, crypto primitives)
stay pure modules.

This page is the map of the **full target design** (plan: `.superpowers/sdd/2026-11-14-oop-redesign/plan.md`).
It is updated every phase.

- **Built** (exists in the code): green, solid border.
- **Planned**: grey, dashed border, with the phase that builds it.

| Phase | What it builds                                                                                                                                                                                                               | State     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 0     | Base layer (`Entity`, `WorkspaceEntity`, contracts), `Actor`, `Caller`, `Role`, `AuditTarget`, `Policy` + 4 policies, `AuditLog`, the error hierarchy, shared hashing; the class-boundary lint rule and test                 | **built** |
| 1     | `Integration` base, `Credential`, auth strategies, read and write sessions, the read-only gate (`Mode`); the provider subclasses wrapping today's code, `TaskProvider`/`CalendarProvider`, `IntegrationRegistry`             | **built** |
| 2a    | The one `static definition` per provider (`IntegrationDefinition`), headers from the auth strategy to the adapters, `OAuthFlow` (Google merged), `ResourcePicker`, capabilities to the client, `Integration`'s collaborators | **built** |
| 2W    | `updateTask`/`writableFields`, `CalendarProvider` update/delete/create calendar/recurrence, `BoardProvider`                                                                                                                  | planned   |
| 3     | `Workspace` aggregate, `Member`, `Invite`, `Topic`, their value objects; `User` reworked                                                                                                                                     | planned   |
| 4     | `Item` hierarchy, `Container`, `ItemQuery`, `CreateQuota`                                                                                                                                                                    | planned   |
| 5     | `SyncRun` state machine, `Integration.sync()`, `Calendar`                                                                                                                                                                    | planned   |
| 6     | `Dashboard`, `History<T>`, the `Block` hierarchy, `View`, `AgentKey`, `ConnectLink`                                                                                                                                          | planned   |
| 7     | The legacy list emptied, dead services deleted                                                                                                                                                                               | planned   |

**How the boundary is held.** `server/legacy-db-importers.mjs` names:

- the database modules (the models' barrel, `models/mongoose/**`, `models/sequelize/**`, the
  connection `config/database.ts` and its providers `config/providers/**`) and packages
  (`mongoose`, `sequelize`, `pg`, `mongodb`);
- the places allowed to load them (classes, models, the connection, migrations, tests);
- the entry points and jobs that may open the connection and nothing else (`lambda.ts`,
  `local.ts`, `stageMaintenance.ts`);
- the test helpers production code never loads (`src/testing/**`, `__tests__/**`);
- `LEGACY_DB_IMPORTERS`, the modules that still reach the database until their phase moves them
  (24 after phase 1; 35 after phase 0, down from 42).

ESLint (`@typescript-eslint/no-restricted-imports`, type imports allowed) and
`src/classes/classBoundary.test.ts` (which also resolves paths, sees dynamic imports and names
`get…Repository` getters) read that one module. The test also holds that only `AuditLog` names the
audit log's repository, and fails on a legacy entry that no longer needs to be there, so the list
only shrinks.

## 1. Base layer, people and permissions

```mermaid
classDiagram
  direction TB

  class Entity~TData~ {
    <<abstract>>
    -data: Readonly~TData~
    +id: string
    +toJSON() TData
    +equals(other) boolean
  }
  class WorkspaceEntity~TData~ {
    <<abstract>>
    +workspaceId: string
    #assertIn(caller) void
  }
  Entity <|-- WorkspaceEntity

  class WorkspaceScoped {
    <<interface>>
    +workspaceId: string
  }
  class Auditable {
    <<interface>>
    +auditTarget() AuditTarget
  }
  class SoftDeletable {
    <<interface>>
    +deletedAt: Date
    +isDeleted: boolean
  }
  class Owned {
    <<interface>>
    +ownerUserId: string
    +isOwnedBy(userId) boolean
  }
  class Versioned {
    <<interface>>
    +version: number
  }
  class Expirable {
    <<interface>>
    +expiresAt: Date
    +isExpired(now) boolean
  }
  class Revocable {
    <<interface>>
    +revoke(caller) Promise
  }
  class Viewable~TView~ {
    <<interface>>
    +toView(caller?) TView
  }
  WorkspaceScoped <|.. WorkspaceEntity

  class Role {
    <<value object>>
    +viewer: Role$
    +editor: Role$
    +owner: Role$
    +of(name)$ Role
    +atLeast(other) boolean
    +equals(other) boolean
  }
  class AuditTarget {
    <<value object>>
    +type: string
    +id: string
    +of(type, id)$ AuditTarget
    +equals(other) boolean
  }
  class Actor {
    +kind: ActorKind
    +userId: string
    +agentId: string
    +ip: string
    +userAgent: string
    +user(userId, origin)$ Actor
    +agent(userId, agentId, origin)$ Actor
    +system()$ Actor
    +from(ref)$ Actor
  }
  class Caller {
    +workspaceId: string
    +userId: string
    +actor: Actor
    +role: Role
    +context: WorkspaceContext
    +enter(workspaceId, actor)$ Caller
    +fromContext(context, actor)$ Caller
    +require(minRole, message?) void
    +can(policy, action, entity) boolean
    +authorize(policy, action, entity) void
  }
  WorkspaceScoped <|.. Caller
  Caller *-- Actor
  Caller *-- Role
  Caller ..> Policy : authorize

  class Policy~TEntity~ {
    <<interface>>
    +canRead(caller, entity) boolean
    +canEdit(caller, entity) boolean
    +canManage(caller, entity) boolean
    +refusal(caller, action, entity) AppError
  }
  class BasePolicy~TEntity~ {
    <<abstract>>
    +canRead(caller, entity)* boolean
    +canEdit(caller, entity)* boolean
    +canManage(caller, entity)* boolean
    +refusal(caller, action, entity) AppError
  }
  class WorkspacePolicy {
    +instance: WorkspacePolicy$
    +roleMay(role, action)$ boolean
    +requireRole(role, action, verb)$ void
  }
  class IntegrationPolicy {
    owner only, 404 for anyone else
    +instance: IntegrationPolicy$
    +isOwn(integration, userId)$ boolean
    +refusal() NotFoundError
  }
  class DashboardPolicy {
    +instance: DashboardPolicy$
  }
  class ItemPolicy {
    -access: ItemAccess
    +for(subject)$ Promise~ItemPolicy~
    +ownFor(subject)$ Promise~ItemPolicy~
    +of(access)$ ItemPolicy
    +filterFor(caller, userFilter?)$ Promise
    +sharedConnectorIds(workspaceId)$ Promise
    +isShared(integration)$ Promise
    +forget(workspaceId)$ void
    +itemFilter(ws, userFilter?) Filter
    +itemFilterUnabsorbed(ws) Filter
    +containerFilter(ws) Filter
    +blockScope(connectors) BlockScope
    +refusal(caller, action, item) AppError
  }
  Policy <|.. BasePolicy
  BasePolicy <|-- WorkspacePolicy
  BasePolicy <|-- IntegrationPolicy
  BasePolicy <|-- DashboardPolicy
  BasePolicy <|-- ItemPolicy

  class AuditLog {
    +action: string
    +actorUserId: string
    +actorAgentId: string
    +target: AuditTarget
    +ip: string
    +userAgent: string
    +meta: Record
    +at: Date
    +record(scope, action, target, meta)$ Promise~AuditLog~
    +list(workspaceId, filter, limit)$ Promise
    +findRecent(workspaceId, query)$ Promise
  }
  WorkspaceEntity <|-- AuditLog
  AuditLog ..> AuditTarget
  AuditLog ..> Actor
  AuditLog ..> Auditable

  class User {
    existing, reworked in phase 3
    +findById(id)$ User
    +findByCognitoSub(sub)$ User
    +upsertFromLogin()$ User
    +deleteAccount()$ void
  }
  class Media {
    existing
  }

  classDef built fill:#d1fae5,stroke:#047857,stroke-width:2px
  classDef planned fill:#f3f4f6,stroke:#9ca3af,stroke-dasharray:5 5,color:#4b5563
  class Entity:::built
  class WorkspaceEntity:::built
  class WorkspaceScoped:::built
  class Auditable:::built
  class SoftDeletable:::built
  class Owned:::built
  class Versioned:::built
  class Expirable:::built
  class Revocable:::built
  class Viewable:::built
  class Role:::built
  class AuditTarget:::built
  class Actor:::built
  class Caller:::built
  class Policy:::built
  class BasePolicy:::built
  class WorkspacePolicy:::built
  class IntegrationPolicy:::built
  class DashboardPolicy:::built
  class ItemPolicy:::built
  class AuditLog:::built
  class User:::built
  class Media:::built
```

The contracts are declared now and implemented by the entity classes of later phases (`Owned` by
`Integration`, `View`, `AgentKey`; `Versioned` by `Dashboard`; `Expirable` by `Invite` and
`AgentKey`; …).

## 2. Errors

```mermaid
classDiagram
  direction TB
  class Error
  class AppError {
    +statusCode: number
    +code: ErrorCode
    +details: Record
  }
  class NotFoundError {
    404 Not found
  }
  class ForbiddenError {
    403
    +forRole(minRole, action)$ ForbiddenError
  }
  class ValidationError {
    400
  }
  class ConflictError {
    409 version conflict
    +currentVersion: number
  }
  class ReadOnlyIntegrationError {
    409 integration_read_only
    +integrationId: string
  }
  class MirroredItemError {
    409
    +openIn: provider, url
  }
  class CapabilityError {
    400
    +capability: string
  }
  class ProviderComingSoonError {
    400 provider_coming_soon
    +provider: string
  }
  class SecretLeakError
  Error <|-- AppError
  Error <|-- SecretLeakError
  AppError <|-- NotFoundError
  AppError <|-- ForbiddenError
  AppError <|-- ValidationError
  AppError <|-- ConflictError
  AppError <|-- ReadOnlyIntegrationError
  AppError <|-- MirroredItemError
  AppError <|-- CapabilityError
  AppError <|-- ProviderComingSoonError

  classDef built fill:#d1fae5,stroke:#047857,stroke-width:2px
  class AppError:::built
  class NotFoundError:::built
  class ForbiddenError:::built
  class ValidationError:::built
  class ConflictError:::built
  class ReadOnlyIntegrationError:::built
  class MirroredItemError:::built
  class CapabilityError:::built
  class ProviderComingSoonError:::built
  class SecretLeakError:::built
```

The 409 domain errors are siblings of `ConflictError`, not children: a `catch (ConflictError)`
answers the version-conflict body (`currentVersion`), which they are not. The error handler answers
every `AppError` by `instanceof`.

## 3. Integrations (phases 1, 2a and 2W)

```mermaid
classDiagram
  direction TB
  class WorkspaceEntity~TData~ {
    <<abstract>>
  }
  class Integration~TConfig,TSecret,TWriter~ {
    <<abstract>>
    -credential: Credential~TSecret~
    #auth: AuthStrategy~TSecret~
    #adapter: ProviderAdapter
    +config: TConfig
    +mode: Mode
    +allowsWrites: boolean
    +authKind: AuthKind
    +canCreate: boolean
    +toView() IntegrationStatusView
    +readConfig(caller)
    +update(caller, input) Promise~Integration~
    +checkMode(caller, mode) Mode
    +canSwitchMode: boolean
    +setMode(caller, mode) Promise~Integration~
    +saveCredential(caller, body) Promise
    +testConnection(caller) Promise
    +requestSync(caller) Promise
    +stopSharing(caller) Promise
    +disconnect(caller) Promise
    +assertWritable(caller)
    +needsWriteConsent() Promise~boolean~
    #definition: IntegrationDefinition
    #withReadSession(fn) Promise
    #withWriteSession(caller, fn) Promise
    #handBackGrant(failure) Promise
    #createWriter(secret)* Promise~TWriter~
    #probe(adapter, context)* Promise
    #onConnected() Promise
    #checkSelection(config) Promise
    #learnedLabel(accountLabel) string
    #revokeGrant() Promise
    +from(data)$ Integration
    +findOwn(caller, id)$ Integration
    +listOwn(caller)$ Integration[]
    +listVisible(caller)$ Integration[]
    +connectWithKey(caller, input)$ Integration
    +connectOAuth(caller, conn)$ ConnectedIntegration
    +forWorker(id)$ Integration
    +listForDispatch()$ Integration[]
    +disconnectAllOf(workspaceId, actor, member)$ number
    +withSyncSecret(id, fn)$ Promise
    +capabilitiesOf()$ ProviderCapabilities[]
  }
  WorkspaceEntity <|-- Integration
  class IntegrationDefinition~TSecret,TAuth~ {
    <<value object>>
    +provider
    +auth: AuthSet
    +connection: ConnectionRules
    +adapter: ProviderAdapter
    +create: CreateRules
    +picker: PickerKind
    +revokePage
    +comingSoon
    +fixtures
    +authFor(method) AuthStrategy
    +parseConfig(config)
    +planConnection(input) ConnectionPlan
    +assertSameAccount(integration, config)
    +defaultLabel(config)
    +fakeCredential(method, name)
  }
  Integration *-- IntegrationDefinition : static definition
  IntegrationDefinition *-- AuthStrategy
  class IntegrationConnector {
    <<collaborator>>
    +connectWithKey(caller, input)
    +upsertOAuth(caller, conn)
  }
  class ConnectionTester {
    <<collaborator>>
    +waitBeforeNext() Promise
    +run(timeZone) Promise
  }
  class SyncRequest {
    <<collaborator>>
    +hold() Promise
    +manualWait() Promise
    +enqueue() Promise
  }
  Integration ..> IntegrationConnector
  Integration ..> ConnectionTester
  Integration ..> SyncRequest
  class Owned {
    <<interface>>
  }
  class Auditable {
    <<interface>>
  }
  class SoftDeletable {
    <<interface>>
  }
  class Viewable~TView~ {
    <<interface>>
  }
  Owned <|.. Integration
  Auditable <|.. Integration
  SoftDeletable <|.. Integration
  Viewable <|.. Integration

  class Mode {
    <<value object>>
    +read$
    +readWrite$
    +allowsWrites: boolean
  }
  class Credential~TSecret~ {
    <<internal>>
    +seal(input, actor)$ Promise
    +of(integrationId)$ Credential
    +meta(workspaceId, id)$ Promise
    +destroy(workspaceId, id)$ Promise
    +open(fn) Promise
    +refreshIfStale(auth, workspaceId) Promise
  }
  class KeyProvider {
    <<interface>>
  }
  Credential ..> KeyProvider
  class AuthStrategy~TSecret~ {
    <<abstract>>
    +kind: AuthKind
    +methods: AuthMethod[]
    +handles(method) boolean
    +parseCredential(method, raw)
    +fakeCredential(method, name)
    +headers(secret, purpose?) Headers
    +query(secret)
    +bind(session) AdapterAuth
    +transport(inner) Transport
  }
  class OAuthAuth~TSecret~ {
    +refreshPolicy: stored | per_call
    +scopes, writeScopes, callbackPath
    +endpoints()
    +credentials() Promise
    +client(transport?) ReadOnlyClient
    +authorizeUrl(request) string
    +exchangeCode(client, grant, credentials) Promise
    +secretFromGrant(grant, scopes, now)
    +identify(client, accessToken) Promise
    +needsRefresh(secret, now) boolean
    +refresh(secret) Promise
    +revoke(secret) Promise
  }
  class ApiKeyAuth~TSecret~
  class ServiceAccountAuth~TSecret~
  class UnofferedAuth~TSecret~ {
    <<null object>>
  }
  AuthStrategy <|-- OAuthAuth
  AuthStrategy <|-- ApiKeyAuth
  AuthStrategy <|-- ServiceAccountAuth
  AuthStrategy <|-- UnofferedAuth
  Credential ..> OAuthAuth : refreshIfStale
  class SyncAdapter~TConfig,TSecret~ {
    <<strategy>>
  }
  Integration *-- Credential
  Integration *-- AuthStrategy
  Integration *-- SyncAdapter
  Integration *-- Mode

  class SupportsOAuth {
    <<interface>>
    +oauth: OAuthAuth
  }
  class SupportsApiKey {
    <<interface>>
    +apiKey: ApiKeyAuth
  }
  class ItemCopy {
    <<value object>>
    +integrationId
    +status
    +key
    +url
  }
  TaskProvider ..> ItemCopy : createTask
  class CreateFunnel {
    <<interface>>
    +createOptions(caller, query)
  }
  class TaskProvider {
    <<interface>>
    +createTask(caller, request) CreatedTask
  }
  class CalendarProvider {
    <<interface>>
    +listCalendars(caller)
    +insertEvent(caller, calendarId, event)
    +dryRun(caller, narrowing, now)
    +push(caller, request)
  }
  CreateFunnel <|-- TaskProvider
  CreateFunnel <|-- CalendarProvider
  class ResourcePicker~R~ {
    <<interface>>
    +pickerKind: sites | workspaces | calendars | null
    +pickerResources(caller) R[]
    +choose(caller, ids)
  }
  class Revocable {
    <<interface>>
    +revoke(caller)
  }
  class BoardProvider {
    <<interface>>
    +boards(caller)
  }
  class CourseProvider {
    <<interface>>
  }

  class TrackerIntegration~TConfig,TSecret~ {
    <<abstract>>
    +createOptions(caller, query)
    +createTask(caller, request)
    #readOptions(session, query)*
    #prepare(session, target, fields)*
    #readClient(transport)
    #writeBases()
  }
  Integration <|-- TrackerIntegration
  TaskProvider <|.. TrackerIntegration
  class JiraIntegration {
    +definition$ = JIRA
  }
  class ClickUpIntegration {
    +definition$ = CLICKUP
  }
  class LinearIntegration {
    +definition$ = LINEAR
  }
  class GitHubIntegration {
    +definition$ = GITHUB
  }
  class GoogleCalendarIntegration {
    +definition$ = GOOGLE_CALENDAR
  }
  class MoodleIntegration {
    +definition$ = MOODLE (comingSoon)
  }
  class UnlistedIntegration {
    <<null object>>
  }
  TrackerIntegration <|-- JiraIntegration
  TrackerIntegration <|-- ClickUpIntegration
  TrackerIntegration <|-- LinearIntegration
  TrackerIntegration <|-- GitHubIntegration
  Integration <|-- GoogleCalendarIntegration
  Integration <|-- MoodleIntegration
  Integration <|-- UnlistedIntegration
  ResourcePicker <|.. JiraIntegration
  SupportsOAuth <|.. JiraIntegration
  SupportsApiKey <|.. JiraIntegration
  ResourcePicker <|.. ClickUpIntegration
  SupportsOAuth <|.. ClickUpIntegration
  SupportsApiKey <|.. ClickUpIntegration
  Revocable <|.. LinearIntegration
  SupportsOAuth <|.. LinearIntegration
  SupportsApiKey <|.. LinearIntegration
  BoardProvider <|.. GitHubIntegration
  SupportsOAuth <|.. GitHubIntegration
  SupportsApiKey <|.. GitHubIntegration
  CalendarProvider <|.. GoogleCalendarIntegration
  ResourcePicker <|.. GoogleCalendarIntegration
  Revocable <|.. GoogleCalendarIntegration
  SupportsOAuth <|.. GoogleCalendarIntegration
  CourseProvider <|.. MoodleIntegration
  SupportsApiKey <|.. MoodleIntegration

  class IntegrationRegistry {
    <<registry>>
    +instance$
    +register(cls, factory)
    +registerFallback(factory)
    +classOf(provider)
    +create(data) Integration
  }
  Integration ..> IntegrationRegistry : from()
  class OAuthFlow {
    <<entity: OAuthState>>
    +start(caller, integrationClass, input)$ OAuthStart
    +consume(integrationClass, callback)$ location
    +providers(caller)$ OAuthProvidersResponse
  }
  OAuthFlow ..> OAuthAuth
  OAuthFlow ..> Integration : connectOAuth

  classDef built fill:#d1fae5,stroke:#047857,stroke-width:2px
  classDef planned fill:#f3f4f6,stroke:#9ca3af,stroke-dasharray:5 5,color:#4b5563
  class WorkspaceEntity:::built
  class Owned:::built
  class Auditable:::built
  class SoftDeletable:::built
  class Viewable:::built
  class Revocable:::built
  class Integration:::built
  class Mode:::built
  class Credential:::built
  class KeyProvider:::planned
  class AuthStrategy:::built
  class OAuthAuth:::built
  class ApiKeyAuth:::built
  class ServiceAccountAuth:::built
  class SyncAdapter:::planned
  class SupportsOAuth:::built
  class SupportsApiKey:::built
  class CreateFunnel:::built
  class TaskProvider:::built
  class CalendarProvider:::built
  class ResourcePicker:::built
  class BoardProvider:::planned
  class CourseProvider:::planned
  class TrackerIntegration:::built
  class JiraIntegration:::built
  class ClickUpIntegration:::built
  class LinearIntegration:::built
  class GitHubIntegration:::built
  class GoogleCalendarIntegration:::built
  class MoodleIntegration:::built
  class UnlistedIntegration:::built
  class IntegrationRegistry:::built
  class OAuthFlow:::built
  class IntegrationDefinition:::built
  class IntegrationConnector:::built
  class ConnectionTester:::built
  class SyncRequest:::built
  class UnofferedAuth:::built
  class ItemCopy:::planned
```

The write gate is the `protected` `withWriteSession`: only provider subclasses reach a writer
(`classes/integration/writers/`: the tracker write client, the Calendar API writer and the push's
ops), and only inside their capability methods. In order, it refuses another member (404), demo
data or a fixtures stage's tracker (`provider_writes_off`), then a read-only integration
(`ReadOnlyIntegrationError`, 409 `integration_read_only`); only then does it open the credential
and make the writer (`createWriter`, the provider's own). `assertWritable` runs the same checks so
callers refuse before they reserve or record anything. The mode is the one the integration was
loaded with: a switch made while a request runs is seen by the next one.

What the tests hold:

- `writePaths.test.ts`:
  - only `TrackerIntegration.ts`, the provider classes and the writer modules load a writer;
  - nothing outside `classes/integration/**` names the writer factories;
  - each factory has one call site, by count: `createWriteClient(` in `TrackerIntegration` and
    `calendarWriter(` in `GoogleCalendarIntegration`, each inside a `createWriter` body, and
    `applyOps(` once, in `GoogleCalendarIntegration`. A writer made in a read session fails;
  - MCP code never names `setMode`, `checkMode` or `UpdateIntegrationBody`.
- `vaultImports.test.ts`: only `Integration.ts` uses `Credential`, and only `Integration.ts` and
  `sync/secrets.ts` name `Integration.withSyncSecret` (MCP code never does).
  An alias does not get round them: a factory renamed with `as`, bound to another name,
  destructured from an `await import(…)` or re-exported fails, as does a dynamic import with no
  literal target inside `classes/integration/`.
- `integration.test.ts`: for every provider class, without a database, each write it can make
  (`createOptions`, `createTask`, `insertEvent`, `push`) is refused while read-only before
  anything is sent.
- `definitions/definitions.test.ts`: the definitions name each connectable provider once, each
  its class's own; every OAuth app's token and revoke URL is on the HTTP layer's allow-list
  (`OAUTH_TOKEN_ENDPOINTS`, written out there on purpose: no definition can widen it) and its
  callback path is the one registered at the provider; the scopes and the key methods are as
  before; the strategies build the headers (a second token for GitHub boards, Moodle's query
  token, one Google token exchange per session, one per call for the service account); and
  `Integration.capabilitiesOf()` agrees with the contracts each class implements.

**What phase 2a built:**

- **One `static definition` per provider class** (`definitions/<provider>.ts`, an
  `IntegrationDefinition`): its auth strategies (`auth.oauth`, `auth.apiKey`,
  `auth.serviceAccount`), the config schema, the connection rules (default topic, account key,
  label, which config change moves the account), the sync adapter, the create rules (funnel
  steps and reader, which links are kept, what a 403 means), the picker, the revoke page,
  `comingSoon` and the fixtures (the funnel's recorded set; each strategy's FAKE credential). It
  replaces `RULES`, `CREDENTIAL_SCHEMAS`, `OAUTH_PROVIDER_DEFS`, `OAUTH_ENDPOINTS`, the
  `fakeCredential` switch and the create switches (`safeCopyUrl`, `failureFor`).
  `definitions/index.ts` lists them for code that must not load the classes (the sync engine in
  fixtures mode, the seed); `services/integrationConfig.ts` and `seed/fakeCredentials.ts` are
  views of them.
- **Headers from the strategy.** The adapters get `ctx.auth` (`AdapterAuth`: `kind`,
  `headers(purpose?)`, `query()`), bound by the integration's strategy to the opened secret and the
  run's client; no adapter builds an auth header, and `authMethod === 'oauth'` checks became
  `auth.kind` / `authKind`, `canCreate` or polymorphism (`pickerKind`). The create path, the
  connection test and the Calendar writer take the same headers.
- **`OAuthFlow`** (an OAuthStates row's lifecycle): `start(caller, integrationClass, input)` and
  `consume(integrationClass, callback)`, the same flow for Google Calendar and the four providers;
  what differs is each provider's `OAuthAuth` (endpoints, scopes, PKCE, the secret it seals, how it
  names the account). Routes, callback URLs, scopes, codes and redirects are unchanged.
- **`ResourcePicker<R>`** (Jira sites, ClickUp workspaces, Google calendars): `pickerKind`,
  `pickerResources(caller)`, `choose(caller, ids)`; the routes pick by `isResourcePicker`.
- **Capabilities to the client**: `GET …/oauth/providers` adds `capabilities[]` from
  `Integration.capabilitiesOf()` (auth methods, picker, revoke on disconnect, revoke page, can
  create, coming soon); the Integrations page reads them instead of its lists.
- **`Integration`'s collaborators**: `IntegrationConnector`, `ConnectionTester`, `SyncRequest`.
  They get the protected members they need as functions; the credential never leaves
  `Integration.ts`. `toStatusView` is gone (`toView`).

**The seams phase 2W fills:**

- `TaskProvider` has `createOptions` (through `CreateFunnel`) and `createTask`; `updateTask` and
  `writableFields` arrive in phase 2W, and the compiler will then require them of every tracker.
- `CalendarProvider` has `listCalendars`, `insertEvent`, `dryRun` and `push`; `updateEvent`,
  `deleteEvent` and `createCalendar` arrive in phase 2W.
- The sync engine reaches a credential through `Integration.withSyncSecret` (a read session) until
  phase 5 moves it behind `Integration.sync()`. Only `sync/secrets.ts` names it, by test.
- `Revocable.revoke(caller)` is its owner's (it checks), over the protected `revokeGrant()` hook,
  which the disconnect template calls whoever disconnects (the owner, or whoever ended the
  owner's membership, who has no standing of the member's own).
- `canSwitchMode` (never demo data) is in the REST view and on the create targets, so the client
  offers the switch, and the "switch to Read & write" hint, only where it can work.

## 4. Items, containers and the calendar (phases 4 and 5)

```mermaid
classDiagram
  direction TB
  class WorkspaceEntity~TData~ {
    <<abstract>>
  }
  class Item {
    <<abstract>>
    +title
    +kind
    +topic
    +overlay: Overlay
    +attributes: AttributeValues
    +editable: boolean*
    +setOverlay(caller, overlay)
    +setAttributes(caller, values)
    +isVisibleTo(caller) boolean
    +from(data)$ Item
  }
  WorkspaceEntity <|-- Item
  class Viewable~TView~ {
    <<interface>>
  }
  class Auditable {
    <<interface>>
  }
  class SoftDeletable {
    <<interface>>
  }
  Viewable <|.. Item
  Auditable <|.. Item
  SoftDeletable <|.. Item
  class ItemPolicy
  Item ..> ItemPolicy : isVisibleTo

  class Todo {
    +update(caller, patch)
    +complete(caller)
    +reopen(caller)
    +delete(caller)
    +copyTo(caller, target)
  }
  class MirroredItem {
    <<abstract>>
    +openIn
  }
  class TaskItem
  class PullRequest
  class CalendarEvent {
    +timeRange: TimeRange
  }
  Item <|-- Todo
  Item <|-- MirroredItem
  MirroredItem <|-- TaskItem
  TaskItem <|-- PullRequest
  MirroredItem <|-- CalendarEvent

  class Editable {
    <<interface>>
  }
  class Completable {
    <<interface>>
  }
  class Deletable {
    <<interface>>
  }
  class HasDueDate {
    <<interface>>
  }
  class Copyable {
    <<interface>>
  }
  class ProviderLinked {
    <<interface>>
    +openIn
  }
  class Schedulable {
    <<interface>>
    +timeRange
  }
  Editable <|.. Todo
  Completable <|.. Todo
  Deletable <|.. Todo
  HasDueDate <|.. Todo
  Copyable <|.. Todo
  ProviderLinked <|.. MirroredItem
  HasDueDate <|.. TaskItem
  Schedulable <|.. CalendarEvent

  class Container
  WorkspaceEntity <|-- Container
  class ItemQuery {
    +for(caller)$ ItemQuery
  }
  ItemQuery ..> ItemPolicy
  class CreateQuota
  class RateLimiter {
    <<interface>>
  }
  RateLimiter <|.. CreateQuota

  class Calendar {
    +plan()
    +push()
    +commit()
  }
  WorkspaceEntity <|-- Calendar
  class CalendarLink
  SoftDeletable <|.. CalendarLink
  Calendar *-- CalendarLink
  class SyncCursor {
    <<value object>>
  }
  class PushPlan {
    <<value object>>
  }
  Calendar *-- SyncCursor
  Calendar *-- PushPlan
  class AttributeValues {
    <<value object>>
  }
  Item *-- AttributeValues
  class Overlay {
    <<value object>>
  }
  class TimeRange {
    <<value object>>
  }
  class DueDate {
    <<value object>>
  }
  class Copies {
    <<value object>>
  }
  Item *-- Overlay
  CalendarEvent *-- TimeRange

  classDef built fill:#d1fae5,stroke:#047857,stroke-width:2px
  classDef planned fill:#f3f4f6,stroke:#9ca3af,stroke-dasharray:5 5,color:#4b5563
  class WorkspaceEntity:::built
  class Viewable:::built
  class Auditable:::built
  class SoftDeletable:::built
  class ItemPolicy:::built
  class Item:::planned
  class Todo:::planned
  class MirroredItem:::planned
  class TaskItem:::planned
  class PullRequest:::planned
  class CalendarEvent:::planned
  class Editable:::planned
  class Completable:::planned
  class Deletable:::planned
  class HasDueDate:::planned
  class Copyable:::planned
  class ProviderLinked:::planned
  class Schedulable:::planned
  class Container:::planned
  class ItemQuery:::planned
  class CreateQuota:::planned
  class RateLimiter:::planned
  class Calendar:::planned
  class CalendarLink:::planned
  class SyncCursor:::planned
  class PushPlan:::planned
  class Overlay:::planned
  class TimeRange:::planned
  class DueDate:::planned
  class Copies:::planned
  class AttributeValues:::planned
```

`Todo.copyTo` is polymorphic: `target.createTask()` for any `TaskProvider`, `target.insertEvent()`
for a `CalendarProvider`, so it gets the read-only gate for free. Changing a source field of a
`MirroredItem` throws `MirroredItemError`.

## 5. Workspace and people (phase 3)

```mermaid
classDiagram
  direction TB
  class Entity~TData~ {
    <<abstract>>
  }
  class WorkspaceEntity~TData~ {
    <<abstract>>
  }
  class Workspace {
    <<aggregate root>>
    +create()$
    +listFor(user)$
    +load(caller)$
    +update(caller, patch)
    +delete(caller)
    +deleteAccountCascade(user)$
  }
  Entity <|-- Workspace
  class Auditable {
    <<interface>>
  }
  class SoftDeletable {
    <<interface>>
  }
  class Expirable {
    <<interface>>
  }
  class Revocable {
    <<interface>>
  }
  Auditable <|.. Workspace
  SoftDeletable <|.. Workspace
  class WorkspaceSettings {
    <<value object>>
  }
  class JoinLink {
    <<value object>>
  }
  class TopicRules {
    <<value object>>
  }
  class AttributeDefinitions {
    <<value object>>
  }
  class AttributeDefinition {
    <<value object>>
  }
  Workspace *-- WorkspaceSettings
  Workspace *-- JoinLink
  Workspace *-- TopicRules
  Workspace *-- AttributeDefinitions
  AttributeDefinitions *-- AttributeDefinition

  class Member {
    +role: Role
    +update(caller, patch)
    +remove(caller)
    +leave(caller)
  }
  class Invite {
    +create(caller, input)$
    +accept(token, user)$
    +pendingFor(email)$
  }
  class Topic {
    +bySlug(caller, slug)$
  }
  WorkspaceEntity <|-- Member
  WorkspaceEntity <|-- Invite
  WorkspaceEntity <|-- Topic
  Auditable <|.. Member
  Auditable <|.. Invite
  Expirable <|.. Invite
  Revocable <|.. Invite
  Auditable <|.. Topic
  class Role {
    <<value object>>
  }
  Member *-- Role
  class User
  class Media
  User ..> Workspace : deleteAccount calls deleteAccountCascade

  classDef built fill:#d1fae5,stroke:#047857,stroke-width:2px
  classDef planned fill:#f3f4f6,stroke:#9ca3af,stroke-dasharray:5 5,color:#4b5563
  class Entity:::built
  class WorkspaceEntity:::built
  class Auditable:::built
  class SoftDeletable:::built
  class Expirable:::built
  class Revocable:::built
  class Role:::built
  class User:::built
  class Media:::built
  class Workspace:::planned
  class WorkspaceSettings:::planned
  class JoinLink:::planned
  class TopicRules:::planned
  class AttributeDefinitions:::planned
  class AttributeDefinition:::planned
  class Member:::planned
  class Invite:::planned
  class Topic:::planned
```

## 6. Dashboards and views (phase 6)

```mermaid
classDiagram
  direction TB
  class WorkspaceEntity~TData~ {
    <<abstract>>
  }
  class Dashboard {
    +save(caller, doc, ifVersion)
    +undo(caller)
    +redo(caller)
    +revert(caller, version)
    +publish(caller)
    +delete(caller)
  }
  WorkspaceEntity <|-- Dashboard
  class Versioned {
    <<interface>>
  }
  class Auditable {
    <<interface>>
  }
  class SoftDeletable {
    <<interface>>
  }
  class Owned {
    <<interface>>
  }
  Versioned <|.. Dashboard
  Auditable <|.. Dashboard
  SoftDeletable <|.. Dashboard
  class History~TDoc~ {
    +patch()
    +inverse()
    +snapshots()
    +prune()
  }
  class Layout {
    <<value object>>
  }
  Dashboard *-- History
  Dashboard *-- Layout
  Dashboard *-- Block
  class DashboardPolicy
  Dashboard ..> DashboardPolicy

  class Block {
    <<abstract>>
    +type*
    +from(json)$ Block
    +check() LintIssue[]
    #lintSpecific()* LintIssue[]
  }
  class DataBlock {
    <<interface>>
    +query() Query
  }
  class TimeBlock {
    <<interface>>
    +range
  }
  class ControlBlock {
    <<interface>>
    +controls()
  }
  class ListBlock
  class TableBlock
  class KanbanBlock
  class ChartBlock
  class CounterBlock
  class DeadlinesBlock
  class TimelineBlock
  class AgendaBlock
  class WorkloadBlock
  class CalendarBlock
  class ClockBlock
  class FilterBlock
  class ActionBlock
  class NoteBlock
  Block <|-- ListBlock
  Block <|-- TableBlock
  Block <|-- KanbanBlock
  Block <|-- ChartBlock
  Block <|-- CounterBlock
  Block <|-- DeadlinesBlock
  Block <|-- TimelineBlock
  Block <|-- AgendaBlock
  Block <|-- WorkloadBlock
  Block <|-- CalendarBlock
  Block <|-- ClockBlock
  Block <|-- FilterBlock
  Block <|-- ActionBlock
  Block <|-- NoteBlock
  DataBlock <|.. ListBlock
  DataBlock <|.. TableBlock
  DataBlock <|.. KanbanBlock
  DataBlock <|.. ChartBlock
  DataBlock <|.. CounterBlock
  DataBlock <|.. DeadlinesBlock
  DataBlock <|.. TimelineBlock
  DataBlock <|.. AgendaBlock
  DataBlock <|.. WorkloadBlock
  DataBlock <|.. CalendarBlock
  TimeBlock <|.. CalendarBlock
  TimeBlock <|.. ClockBlock
  ControlBlock <|.. FilterBlock
  ControlBlock <|.. ActionBlock

  class View
  WorkspaceEntity <|-- View
  Owned <|.. View
  Auditable <|.. View
  class Query {
    <<value object>>
  }
  View *-- Query

  classDef built fill:#d1fae5,stroke:#047857,stroke-width:2px
  classDef planned fill:#f3f4f6,stroke:#9ca3af,stroke-dasharray:5 5,color:#4b5563
  class WorkspaceEntity:::built
  class Versioned:::built
  class Auditable:::built
  class SoftDeletable:::built
  class Owned:::built
  class DashboardPolicy:::built
  class Dashboard:::planned
  class History:::planned
  class Layout:::planned
  class Block:::planned
  class DataBlock:::planned
  class TimeBlock:::planned
  class ControlBlock:::planned
  class ListBlock:::planned
  class TableBlock:::planned
  class KanbanBlock:::planned
  class ChartBlock:::planned
  class CounterBlock:::planned
  class DeadlinesBlock:::planned
  class TimelineBlock:::planned
  class AgendaBlock:::planned
  class WorkloadBlock:::planned
  class CalendarBlock:::planned
  class ClockBlock:::planned
  class FilterBlock:::planned
  class ActionBlock:::planned
  class NoteBlock:::planned
  class View:::planned
  class Query:::planned
```

## 7. Sync, agent keys and the outside world (phases 5 and 6)

```mermaid
classDiagram
  direction TB
  class WorkspaceEntity~TData~ {
    <<abstract>>
  }
  class SyncRun {
    <<state machine>>
    -status
    +start()
    +succeed(counts)
    +fail(reason)
    +cancel()
  }
  WorkspaceEntity <|-- SyncRun
  class SyncCursor {
    <<value object>>
  }
  SyncRun ..> SyncCursor
  class AgentKey {
    +authenticate(raw)$ AgentKey
    +scopes: ScopeSet
  }
  WorkspaceEntity <|-- AgentKey
  class Owned {
    <<interface>>
  }
  class Expirable {
    <<interface>>
  }
  class Revocable {
    <<interface>>
  }
  class Auditable {
    <<interface>>
  }
  Owned <|.. AgentKey
  Expirable <|.. AgentKey
  Revocable <|.. AgentKey
  Auditable <|.. AgentKey
  class ScopeSet {
    <<value object>>
    scopes ∩ role
  }
  AgentKey *-- ScopeSet
  class ConnectLink {
    +create(caller, provider)$
    +consume(caller, raw)$
  }
  class KeyProvider {
    <<interface>>
  }
  class Transport {
    <<interface>>
  }
  class Mailer {
    <<interface>>
  }
  class ObjectStore {
    <<interface>>
  }
  class Clock {
    <<interface>>
  }

  classDef built fill:#d1fae5,stroke:#047857,stroke-width:2px
  classDef planned fill:#f3f4f6,stroke:#9ca3af,stroke-dasharray:5 5,color:#4b5563
  class WorkspaceEntity:::built
  class Owned:::built
  class Expirable:::built
  class Revocable:::built
  class Auditable:::built
  class SyncRun:::planned
  class SyncCursor:::planned
  class AgentKey:::planned
  class ScopeSet:::planned
  class ConnectLink:::planned
  class KeyProvider:::planned
  class Transport:::planned
  class Mailer:::planned
  class ObjectStore:::planned
  class Clock:::planned
```

The outside-world interfaces invert today's test seams (`set…ForTests`): production wires KMS,
SES, S3 and the real clock; tests wire the fakes. Behaviour does not change.

## Where phase 2a left the old modules

| Module                             | State after phase 2a                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/googleCalendarOAuth.ts`  | **removed**: `OAuthFlow` (start, callback) and `GoogleCalendarIntegration`'s definition; the picker route helper is in `services/oauth/service.ts` |
| `services/googleOAuthClient.ts`    | **removed**: `GOOGLE_CALENDAR_OAUTH` (`OAuthAuth`: credentials, token client, per-call refresh, revoke)                                            |
| `services/oauth/providers.ts`      | **removed**: each provider's `OAuthAuth` in its definition (`identify`, scopes, endpoints)                                                         |
| `services/oauth/client.ts`         | **removed**: `OAuthAuth#credentials`, `#client`, `#refresh`                                                                                        |
| `services/oauth/service.ts`        | the request bodies and the picker listings (over `ResourcePicker`); the flow is `OAuthFlow`                                                        |
| `services/oauth/common.ts`         | pure (cookie, callback URL, redirects); the state's database work is `OAuthFlow`'s; off the legacy list                                            |
| `services/oauth/transport.ts`      | the OAuth apps' transport seam only; the stand-in rewrite is `OAuthAuth#transport`                                                                 |
| `services/integrationConfig.ts`    | the request bodies, and views of the definitions                                                                                                   |
| `seed/fakeCredentials.ts`          | a view of the strategies' FAKE credentials (the pieces: `definitions/fake.ts`)                                                                     |
| `sync/providers/oauthEndpoints.ts` | the test stand-in switch only; the endpoints are the definitions'                                                                                  |

## Where phase 1 left the old modules

| Module                                                      | State after phase 1                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `services/integrations.ts`                                  | **removed**: `Integration` (connect within caps, update, disconnect template, providers by member)                 |
| `services/integrationConnect.ts`                            | **removed**: `Integration.connectOAuth`                                                                            |
| `services/integrationCredentials.ts`                        | **removed**: `Integration#saveCredential`                                                                          |
| `services/integrationOwnership.ts`                          | **removed**: `Integration.findOwn`, `findOwnIncludingDeleted`, `listOwn`, `listVisible`                            |
| `services/integrationTest.ts`                               | **removed**: `Integration#testConnection` (template over `probe`) and `classes/integration/connectionTest.ts`      |
| `services/sharing.ts`                                       | **removed**: `Integration#stopSharing`, `Integration.sharedOwnIds`                                                 |
| `services/crypto/credentialVault.ts`, `credentialWriter.ts` | **removed**: `Credential` (`open`, `seal`, `refreshIfStale`)                                                       |
| `services/providerCreate/session.ts`                        | **removed**: the tracker read and write sessions (`TrackerIntegration`)                                            |
| `services/providerCreate/writeClient.ts`                    | moved to `classes/integration/writers/trackerWriter.ts`                                                            |
| `gcal/calendarApi.ts`                                       | moved to `classes/integration/writers/calendarApi.ts` (the push's ops: `writers/calendarOps.ts`)                   |
| `gcal/oauthCalendar.ts`                                     | **removed**: `GoogleCalendarIntegration` (calendars, insert, push, pull, revoke)                                   |
| `services/oauth/grants.ts`                                  | **removed**: Jira/ClickUp `grantResources`, `LinearIntegration#revoke`, `classes/integration/grantSelection.ts`    |
| `services/gcalSync.ts`, `gcal/scheduledSync.ts`             | thin over `GoogleCalendarIntegration` (`dryRun`, `push`); off the legacy list                                      |
| `services/providerCreate/service.ts`                        | the copy bookkeeping stays (items, quota: phase 4 `Todo.copyTo`); the writes go through `createTask`/`insertEvent` |
| `services/syncRuns.ts`                                      | the run history stays (phase 5); "sync now" is `Integration#requestSync`                                           |

## Where phase 0 left the old modules

| Module                                    | State after phase 0                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `services/itemAccess.ts`                  | **removed**: its rules and share facts are `ItemPolicy`                                              |
| `services/accessFilter.ts`                | thin delegation to `ItemPolicy` (the builder's compile test calls these names); re-exports the types |
| `services/workspaceContext.ts`            | thin delegation to `Caller.enter` (tests resolve a context by this name)                             |
| `services/integrationOwnership.ts`        | the loads stayed until phase 1 (`Integration.findOwn`); the rule is `IntegrationPolicy`              |
| `services/sharing.ts`                     | stop sharing orchestrated there until phase 1 (`Integration#stopSharing`)                            |
| `assertRole` (`services/integrations.ts`) | **removed**: `caller.require(minRole)`                                                               |
| `assertOwner` (`services/workspaces.ts`)  | `caller.authorize(WorkspacePolicy.instance, 'manage', …)`                                            |
| the 8 audit helpers and inline appends    | **removed**: `AuditLog.record` is the only writer                                                    |

Every audited request records its address and user agent: controllers pass `req.caller.actor`
(or, before a workspace exists and on the OAuth callbacks, the request's origin) and MCP tools pass
their caller's actor. Jobs and the sync write as the system, without an origin.

Rules that still live in a service until their phase moves them into a class:

| Rule                                                        | Where                                                                           | Moves with              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------- |
| A private saved view is its owner's alone                   | `services/views.ts` (`visibleTo`), `services/workspaceQuery.ts` (the view path) | `View` (phase 6)        |
| Only your own local to-do is copied to a provider           | `services/providerCreate/service.ts` (`loadTodo`)                               | `Todo.copyTo` (phase 4) |
| Agent-key visibility and revoking (owner or the key's user) | `services/agentKeys.ts`, through `WorkspacePolicy`                              | `AgentKey` (phase 6)    |
