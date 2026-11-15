import { Router } from 'express';
import {
  GoogleCalendarOAuthController,
  IntegrationsController,
  ProviderOAuthController,
} from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';
import { sensitiveBody } from '../../middlewares/sensitiveBody.js';
import type { CleanupProgress } from '../../types/primaryCalendar.js';
import type { IntegrationStatusView } from '../../models/definitions/Integration.js';
import type { AuthMethod, IntegrationMode } from '../../types/domain.js';
import type {
  ConnectableProvider,
  IntegrationConfigs,
  IntegrationCredential,
  IntegrationTestResult,
  OAuthProvidersResponse,
  OAuthResource,
} from '../../types/integrations.js';

/**
 * Integrations (BACKEND.md §4, DATA.md §0, §3.4–3.5, §4, §7, PERMISSIONS-V2). An integration
 * belongs to one member inside one workspace and is only ever shown to them, as
 * `IntegrationStatusView`: `{id, provider, authMethod, accountLabel, status, mode,
 * canSwitchMode, expiresAt, lastSyncAt}`. The secret goes one way, in the body of `PUT …/credential` (write-only,
 * 204, never logged).
 *
 * Behind requireWorkspace: non-members get 404. Editors and owners connect their own
 * integrations; viewers get 403. Every route on one integration is its owner's alone, whatever
 * their role: for anyone else (workspace owners too) the id is 404, like an id from another
 * workspace. Other members' integrations show only as provider icons on the members list.
 */
const router = Router();

// ─── GET /api/private/workspaces/:wid/integrations ──────────────────────────

/** Viewer. The member's own integrations, oldest first: the status keys only. */
export type ListIntegrationsResponseData = IntegrationStatusView[];

router.get(
  '/workspaces/:wid/integrations',
  requireWorkspace('viewer'),
  IntegrationsController.list,
);

// ─── GET /api/private/workspaces/:wid/integrations/sharing ──────────────────

/**
 * Viewer. Which of the caller's own integrations are shared (PERMISSIONS-V2 share-on-attach):
 * the ids of those that are a connector on some block of some dashboard here, drafts and
 * published copies alike, so the whole workspace sees their items. Never another member's.
 */
export interface IntegrationSharingResponseData {
  shared: string[];
}

router.get(
  '/workspaces/:wid/integrations/sharing',
  requireWorkspace('viewer'),
  IntegrationsController.sharing,
);

// ─── POST /api/private/workspaces/:wid/integrations ─────────────────────────

/**
 * Editor. 201: the integration is the caller's own. Non-secret config only, validated per
 * provider (400 names the field). Defaults per
 * provider: the topic (overridable; the workspace's work, college or personal topic when it has
 * it, else none), the account (the Jira or Moodle site host, the GitHub owner, else a placeholder
 * until the first successful test) and the label. A GitHub user adds the topic rule
 * `<login>/* → personal` when the workspace has a personal topic. The new integration has no credential: it shows `error` until
 * `PUT …/credential`. 409 for an account the caller already connected here, or at a cap (20
 * of the caller's own, 100 in the workspace).
 */
export type CreateIntegrationRequestBody = {
  [P in ConnectableProvider]: {
    provider: P;
    label?: string;
    /** A topic of the workspace; null = none (Unsorted). An unknown topic is 400. */
    topicId?: string | null;
    /** The auth method; each provider's default applies when omitted. */
    authMethod?: AuthMethod;
    config: IntegrationConfigs[P];
  };
}[ConnectableProvider];

export type CreateIntegrationResponseData = IntegrationStatusView;

router.post(
  '/workspaces/:wid/integrations',
  requireWorkspace('editor'),
  IntegrationsController.create,
);

// ─── PUT /api/private/workspaces/:wid/integrations/:iid/credential ──────────

/**
 * Its owner (any role). 204 with no body. The secret JSON for the integration's auth method, write-only: sealed
 * at rest, never logged, echoed or returned in any form. A shape that doesn't fit is 400 with one
 * fixed message. Saving it again rotates it, and makes the integration `active` (connected) again.
 */
export type SaveCredentialRequestBody = IntegrationCredential;

router.put(
  '/workspaces/:wid/integrations/:iid/credential',
  sensitiveBody,
  requireWorkspace('viewer'),
  IntegrationsController.saveCredential,
);

// ─── POST /api/private/workspaces/:wid/integrations/:iid/test ───────────────

/**
 * Its owner. 200 `{ok: true, accountLabel, capabilities?}` or `{ok: false, code}` (a fixed code, never
 * provider text). `auth_failed` marks the integration `error` (reconnect).
 */
export type TestIntegrationResponseData = IntegrationTestResult;

router.post(
  '/workspaces/:wid/integrations/:iid/test',
  requireWorkspace('viewer'),
  IntegrationsController.test,
);

// ─── GET /api/private/workspaces/:wid/integrations/:iid/config ──────────────

/**
 * Its owner. The integration's non-secret config, validated again: only the provider's settings, never
 * a credential field (for the edit form). 409 when the stored config no longer validates.
 */
export type GetIntegrationConfigResponseData = IntegrationConfigs[ConnectableProvider];

router.get(
  '/workspaces/:wid/integrations/:iid/config',
  requireWorkspace('viewer'),
  IntegrationsController.config,
);

// ─── POST /api/private/workspaces/:wid/integrations/google-calendar/oauth/start ─

/** `integrationId`: a reconnect of that Google Calendar. `lng`: the page the callback returns to. */
export interface StartGoogleCalendarOAuthRequestBody {
  integrationId?: string;
  lng?: 'en' | 'he';
}

/**
 * Editor (a new connection) or the owner of `integrationId` (a reconnect, any role). Google
 * Calendar with Google OAuth (authorization code + PKCE S256, offline access):
 * the URL to send the browser to, plus an HttpOnly cookie that binds the flow to this browser.
 * Google returns the browser to `GET /api/public/oauth/google-calendar/callback`, which lands on
 * `/<lng>/integrations?connected=<iid>` or `?oauth_error=<code>`. 409 `oauth_unavailable` when
 * the server has no Google OAuth client.
 */
export interface StartGoogleCalendarOAuthResponseData {
  authorizeUrl: string;
}

router.post(
  '/workspaces/:wid/integrations/google-calendar/oauth/start',
  requireWorkspace('viewer'),
  GoogleCalendarOAuthController.start,
);

// ─── OAuth sign-in for GitHub, Jira, ClickUp and Linear ─────────────────────

/** `integrationId`: a reconnect of that connection. `lng`: the page the callback returns to. */
export interface StartProviderOAuthRequestBody {
  integrationId?: string;
  lng?: 'en' | 'he';
  /** H5: also ask for the write scope (Jira, Linear), so a to-do can be created there. */
  includeWrite?: boolean;
}

/**
 * Editor (a new connection) or the owner of `integrationId` (a reconnect, any role).
 * `POST …/integrations/oauth/:provider/start` (`github`, `jira`, `clickup` or `linear`):
 * the URL to send the browser to, plus the HttpOnly binding cookie. The provider returns the
 * browser to `GET /api/public/oauth/:provider/callback`, which lands on
 * `/<lng>/integrations?connected=<iid>` or `?oauth_error=<code>`. 409 `oauth_unavailable` when
 * the server has no OAuth app for the provider; 404 for any other `:provider`.
 */
export interface StartProviderOAuthResponseData {
  authorizeUrl: string;
}

router.post(
  '/workspaces/:wid/integrations/oauth/:provider/start',
  requireWorkspace('viewer'),
  ProviderOAuthController.start,
);

/**
 * Viewer. `GET …/integrations/oauth/providers`: per provider whether this server can sign in with
 * it, plus what the setup guide shows (callback URL, scopes, console link, secret name). No secret.
 */
export type ListOAuthProvidersResponseData = OAuthProvidersResponse;

router.get(
  '/workspaces/:wid/integrations/oauth/providers',
  requireWorkspace('viewer'),
  ProviderOAuthController.providers,
);

/**
 * Its owner. `GET …/integrations/:iid/oauth/resources`: what a Jira (sites) or ClickUp (workspaces)
 * connection can read, live, to pick from (then PATCH `config.sites` / `config.teamIds`). 409 for
 * another kind of integration or a refused grant; 502 when the provider does not answer.
 */
export type ListOAuthResourcesResponseData = OAuthResource[];

router.get(
  '/workspaces/:wid/integrations/:iid/oauth/resources',
  requireWorkspace('viewer'),
  ProviderOAuthController.resources,
);

// ─── GET /api/private/workspaces/:wid/integrations/:iid/calendars ───────────

/**
 * Its owner. The calendars of a Google Calendar connected with Google (Google's calendarList), for
 * the calendar picker: only `owner` and `writer` calendars can take a push. 409 for another kind
 * of integration, or when Google refused the grant (reconnect); 502 when Google did not answer.
 */
export type ListGoogleCalendarsResponseData = {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}[];

router.get(
  '/workspaces/:wid/integrations/:iid/calendars',
  requireWorkspace('viewer'),
  GoogleCalendarOAuthController.calendars,
);

// ─── PATCH /api/private/workspaces/:wid/integrations/:iid ───────────────────

/**
 * Its owner. At least one change. The config is validated again and must stay on the same account
 * (site, owner). Never the provider, the status or the secret. `mode` switches the integration
 * between read-only (`read`, the default of every new connection: nothing is ever changed at the
 * provider) and `read_write` (creating to-dos there and pushing to Google Calendar); demo data
 * refuses `read_write` (400). Audited as `integration.mode`.
 */
export interface UpdateIntegrationRequestBody {
  mode?: IntegrationMode;
  label?: string;
  /** A topic of the workspace; null = none (Unsorted). */
  topicId?: string | null;
  config?: IntegrationConfigs[ConnectableProvider];
  /**
   * When the credential stops working: an ISO date-time with its offset, or a date; null clears
   * it. Saving a new credential (a rotation) clears it too.
   */
  expiresAt?: string | null;
}

export type UpdateIntegrationResponseData = IntegrationStatusView;

router.patch(
  '/workspaces/:wid/integrations/:iid',
  requireWorkspace('viewer'),
  IntegrationsController.update,
);

// ─── POST /api/private/workspaces/:wid/integrations/:iid/stop-sharing ───────

/**
 * Its owner. "Stop sharing" (PERMISSIONS-V2): the integration's connectors come off every block
 * of every dashboard of the workspace, drafts and published copies, each change a new dashboard
 * version, so its items are private to the owner again. `dashboards`: how many changed.
 */
export interface StopSharingResponseData {
  dashboards: number;
}

router.post(
  '/workspaces/:wid/integrations/:iid/stop-sharing',
  requireWorkspace('viewer'),
  IntegrationsController.stopSharing,
);

// ─── POST /api/private/workspaces/:wid/integrations/:iid/remove-pushed ──────

/**
 * Its owner, a Google Calendar integration that is read & write (409 `integration_read_only`; 400
 * for another provider). "Remove" the events TodoList pushed with it (an earlier workspace
 * calendar's leftovers, or the old one's on Change and Stop): each through the write session,
 * its link tombstoned, within the push's 20 s budget. Done: `{events, remaining: 0}`. Out of
 * time: `409 {message, code: 'cleanup_incomplete', progress: {events, calendars, calendarsKept,
 * remaining}}`: call again to go on. Never MCP. Audited as `integration.cleanup` (counts only).
 */
export interface RemovePushedResponseData {
  events: number;
  remaining: 0;
  /** Events on the current workspace calendar, left in place. */
  skipped: number;
  /** Events Google refused to remove (no permission): no longer tracked. */
  failed: number;
}

router.post(
  '/workspaces/:wid/integrations/:iid/remove-pushed',
  requireWorkspace('viewer'),
  IntegrationsController.removePushed,
);

// ─── DELETE /api/private/workspaces/:wid/integrations/:iid ──────────────────

/**
 * Its owner. 204 (200 with the clean-up's counts when `removeAdded` ran). Disconnects: the integration is deleted first, then its credential is wiped (and
 * checked gone), then its items and containers are soft-deleted. `?removeAdded=true` (Google
 * Calendar: "Also remove everything TodoList added to this calendar") first deletes every event
 * TodoList pushed with it and each calendar TodoList created there that holds nothing else, then
 * its links; it needs the integration read & write (409 `integration_read_only`), 400 for another
 * provider, and a Google failure (502, 409 to reconnect) stops before anything is disconnected.
 * It has the push's 20 s budget: out of time, `409 {message, code: 'cleanup_incomplete',
 * progress}` and the integration stays connected (call again to go on, or disconnect without
 * it). Audited as `integration.cleanup` (counts only).
 */
export interface DisconnectIntegrationQuery {
  removeAdded?: 'true' | 'false';
}

/**
 * With `removeAdded`, once the clean-up completed and the integration is disconnected: 200 with
 * what the clean-up did (`remaining` 0; `failed` and `skipped` steps included). Without: 204.
 */
export type DisconnectIntegrationResponseData = CleanupProgress;
router.delete(
  '/workspaces/:wid/integrations/:iid',
  requireWorkspace('viewer'),
  IntegrationsController.remove,
);

export { router as integrationsRouter };
