/**
 * The checked-in route manifest of the secret-leak suite: every route the app registers, with how
 * to call it. A route the walk finds that is not listed here fails the suite, and so does an entry
 * whose route is gone, so a new route cannot ship without being called under the leak checks.
 *
 * Entries run in order: destructive ones come last. Nothing here holds a secret; the suite seeds
 * those at run time (seed.ts).
 */

import { FAKE_COGNITO_PASSWORD } from '../../testing/fakeCognito.js';

/** What the suite created before the manifest runs. */
export interface Ctx {
  wid: string;
  /** A second workspace whose owner is the throwaway user (deleted with the account). */
  throwawayWid: string;
  itemId: string;
  /** A weekly time block of the workspace owner's (Sundays 13:00–17:00 in Jerusalem). */
  timeBlockId: string;
  /**
   * The owner's travel: a place of theirs (not Home), a where-rule, and a leg of the time block
   * (every occurrence of it is marked for travel).
   */
  travel: { placeId: string; ruleId: string; legId: string };
  dashboardId: string;
  /** Kept current by the runner from every answer about the dashboard. */
  dashboardVersion: number;
  viewId: string;
  /** A topic (page) of the main workspace, renamed then deleted by the manifest. */
  topicId: string;
  inviteId: string;
  inviteToken: string;
  agentKeyId: string;
  /** Members of the main workspace, for the member routes. */
  memberIds: { patched: string; removed: string };
  integrations: Record<'jira' | 'clickup' | 'linear' | 'moodle' | 'github' | 'gcal', string>;
}

export type Actor = 'owner' | 'member' | 'throwaway' | 'anon';

export interface Entry {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The route's full path with its `:param` placeholders, exactly as the walk reports it. */
  path: string;
  /** Default: the workspace owner. */
  as?: Actor;
  /** Values for the placeholders; `:wid` defaults to the main workspace. */
  params?: (c: Ctx) => Record<string, string>;
  query?: string;
  body?: (c: Ctx) => unknown;
  /** Accepted status classes (2 = 2xx, 4 = 4xx). A 5xx is never accepted. */
  expect: readonly (2 | 4)[];
  /** Left out of the bad-input pass: the body is empty, or the route only deletes. */
  noBadInput?: true;
}

const P = '/api/private';
const W = `${P}/workspaces/:wid`;

const item = (c: Ctx): Record<string, string> => ({ id: c.itemId });
const jira = (c: Ctx): Record<string, string> => ({ iid: c.integrations.jira });
const dash = (c: Ctx): Record<string, string> => ({ id: c.dashboardId });
const versioned = (c: Ctx): { expectedVersion: number } => ({
  expectedVersion: c.dashboardVersion,
});

export const MANIFEST: readonly Entry[] = [
  // ── public ────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/public/runtime', as: 'anon', expect: [2] },
  {
    method: 'POST',
    path: '/api/public/auth/signup',
    as: 'anon',
    body: () => ({
      email: 'manifest-signup@example.test',
      password: FAKE_COGNITO_PASSWORD,
      name: 'Signup',
    }),
    expect: [2, 4],
  },
  {
    method: 'POST',
    path: '/api/public/auth/confirm',
    as: 'anon',
    body: () => ({ email: 'manifest-signup@example.test', code: '123456' }),
    expect: [2, 4],
  },
  {
    method: 'POST',
    path: '/api/public/auth/resend-confirmation',
    as: 'anon',
    body: () => ({ email: 'manifest-signup@example.test' }),
    expect: [2, 4],
  },
  {
    method: 'POST',
    path: '/api/public/auth/login',
    as: 'anon',
    body: () => ({ email: 'manifest-login@example.test', password: FAKE_COGNITO_PASSWORD }),
    expect: [2],
  },
  {
    method: 'POST',
    path: '/api/public/auth/forgot-password',
    as: 'anon',
    body: () => ({ email: 'manifest-signup@example.test' }),
    expect: [2, 4],
  },
  {
    method: 'POST',
    path: '/api/public/auth/reset-password',
    as: 'anon',
    body: () => ({
      email: 'manifest-signup@example.test',
      code: '123456',
      password: FAKE_COGNITO_PASSWORD,
    }),
    expect: [2, 4],
  },
  {
    method: 'POST',
    path: '/api/public/auth/refresh',
    as: 'anon',
    body: () => ({ refreshToken: 'not-a-token' }),
    expect: [4],
  },
  // The Google Calendar OAuth callback: always a 302 to `/<lng>/integrations?oauth_error=…` (a
  // relative Location, so the runner follows it to this API's own 404). Never a token or a code.
  {
    method: 'GET',
    path: '/api/public/oauth/google-calendar/callback',
    as: 'anon',
    query: 'state=FAKEstate0123456789abcdefghijklmnopqrstuvwxyzA&code=FAKE-code-0123',
    expect: [4],
  },
  // The GitHub, Jira, ClickUp and Linear OAuth callbacks: the same contract as Google's.
  {
    method: 'GET',
    path: '/api/public/oauth/:provider/callback',
    as: 'anon',
    params: () => ({ provider: 'linear' }),
    query: 'state=FAKEstate0123456789abcdefghijklmnopqrstuvwxyzA&code=FAKE-code-0123',
    expect: [4],
  },

  // ── account ───────────────────────────────────────────────────────────────
  { method: 'GET', path: `${P}/me`, expect: [2] },
  { method: 'PUT', path: `${P}/me`, body: () => ({ name: 'Owner' }), expect: [2] },
  { method: 'POST', path: `${P}/me/test-email`, expect: [2, 4] },
  { method: 'GET', path: `${P}/me/export`, expect: [2, 4] },
  {
    method: 'PUT',
    path: `${P}/me/default-workspace`,
    body: (c) => ({ workspaceId: c.wid }),
    expect: [2],
  },
  { method: 'GET', path: `${P}/me/invites`, expect: [2] },
  {
    method: 'POST',
    path: `${P}/uploads/presign`,
    body: () => ({ purpose: 'avatar', fileName: 'a.png', mimeType: 'image/png' }),
    expect: [2, 4],
  },
  { method: 'GET', path: `${P}/dashboard`, expect: [2] },

  // ── workspaces, members, invites ───────────────────────────────────────
  { method: 'GET', path: `${P}/workspaces`, expect: [2] },
  {
    method: 'POST',
    path: `${P}/workspaces`,
    body: () => ({ name: 'Manifest created' }),
    expect: [2],
  },
  { method: 'GET', path: W, expect: [2] },
  { method: 'PATCH', path: W, body: () => ({ settings: { weekStart: 'mon' } }), expect: [2] },
  { method: 'GET', path: `${W}/members`, expect: [2] },
  // Former members' private to-dos: a count, then a delete; never their content.
  { method: 'GET', path: `${W}/former-member-todos`, expect: [2] },
  { method: 'DELETE', path: `${W}/former-member-todos`, expect: [2], noBadInput: true },
  {
    method: 'PATCH',
    path: `${W}/members/:uid`,
    params: (c) => ({ uid: c.memberIds.patched }),
    body: () => ({ role: 'editor' }),
    expect: [2],
  },
  { method: 'GET', path: `${W}/invites`, expect: [2] },
  {
    method: 'POST',
    path: `${W}/invites`,
    body: () => ({ email: 'manifest-invitee@example.test', role: 'viewer' }),
    expect: [2],
  },
  {
    method: 'POST',
    path: `${P}/invites/:token/accept`,
    params: (c) => ({ token: c.inviteToken }),
    expect: [2, 4],
  },
  // The join link: the token comes back to the owner only, and goes in on accept.
  { method: 'GET', path: `${W}/join-link`, expect: [2] },
  {
    method: 'PUT',
    path: `${W}/join-link`,
    body: () => ({ enabled: true, role: 'viewer' }),
    expect: [2],
  },
  { method: 'POST', path: `${W}/join-link/reset`, expect: [2, 4], noBadInput: true },
  {
    method: 'POST',
    path: `${P}/join-links/accept`,
    as: 'throwaway',
    body: () => ({ token: 'a'.repeat(43) }),
    expect: [4],
  },
  {
    method: 'DELETE',
    path: `${W}/invites/:id`,
    params: (c) => ({ id: c.inviteId }),
    expect: [2, 4],
    noBadInput: true,
  },

  // ── topics (pages) ────────────────────────────────────────────────────────
  { method: 'GET', path: `${W}/topics`, expect: [2] },
  {
    method: 'POST',
    path: `${W}/topics`,
    body: () => ({ name: 'Manifest page', templateKey: 'work@1' }),
    expect: [2],
  },
  {
    method: 'PATCH',
    path: `${W}/topics/:tid`,
    params: (c) => ({ tid: c.topicId }),
    body: () => ({ name: 'Renamed page', colour: 'teal' }),
    expect: [2],
  },

  // ── attributes (H4) ───────────────────────────────────────────────────────
  { method: 'GET', path: `${W}/attributes`, expect: [2] },
  {
    method: 'POST',
    path: `${W}/attributes`,
    body: () => ({ key: 'manifest_attr', name: 'Manifest', type: 'text' }),
    expect: [2],
  },
  {
    method: 'PATCH',
    path: `${W}/attributes/:key`,
    params: () => ({ key: 'importance' }),
    body: () => ({ name: 'Importance' }),
    expect: [2],
  },
  {
    method: 'DELETE',
    path: `${W}/attributes/:key`,
    params: () => ({ key: 'manifest_attr' }),
    expect: [2, 4],
    noBadInput: true,
  },
  {
    method: 'POST',
    path: `${W}/attributes/subject/match-counts`,
    body: () => ({ subjects: [{ name: 'Calculus', patterns: ['*calc*'] }] }),
    expect: [2],
  },

  // ── items and facets ──────────────────────────────────────────────────────
  { method: 'GET', path: `${W}/items`, query: 'q=lin_api', expect: [2] },
  {
    method: 'POST',
    path: `${W}/items`,
    body: () => ({ title: 'Manifest item', idempotencyKey: 'manifest-1' }),
    expect: [2],
  },
  { method: 'GET', path: `${W}/items/:id`, params: item, expect: [2] },
  {
    method: 'PATCH',
    path: `${W}/items/:id`,
    params: item,
    body: () => ({ title: 'Renamed' }),
    expect: [2],
  },
  {
    method: 'PATCH',
    path: `${W}/items/:id/overlay`,
    params: item,
    body: () => ({ pinned: true }),
    expect: [2, 4],
  },
  {
    method: 'POST',
    path: `${W}/items/:id/complete`,
    params: item,
    body: () => ({ done: true }),
    expect: [2],
  },
  // H5: creating a to-do in the caller's own providers too. Targets list; options and create are
  // 4xx here (the seeded Jira connection is not the caller's own, and nothing is switched on).
  { method: 'GET', path: `${W}/provider-create/targets`, expect: [2] },
  {
    method: 'GET',
    path: `${W}/integrations/:iid/create-options`,
    params: jira,
    query: 'step=site',
    expect: [2, 4],
  },
  {
    method: 'POST',
    path: `${W}/items/:id/copies`,
    params: item,
    body: (c) => ({
      requestId: 'manifest-request-1',
      integrationId: c.integrations.jira,
      target: { provider: 'jira', projectId: '10001', issueTypeId: '10002' },
    }),
    expect: [2, 4],
  },
  // Time blocks: the seeded block is weekly from Sunday 22 November 2026, 13:00 in Jerusalem.
  {
    method: 'POST',
    path: `${W}/time-blocks`,
    body: () => ({
      subject: 'Manifest subject',
      startAt: '2026-11-23T08:00:00.000Z',
      endAt: '2026-11-23T09:00:00.000Z',
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
      idempotencyKey: 'manifest-block-1',
    }),
    expect: [2],
  },
  {
    method: 'PATCH',
    path: `${W}/time-blocks/:id`,
    params: (c) => ({ id: c.timeBlockId }),
    body: () => ({
      scope: 'this',
      originalStart: '2026-11-29T11:00:00.000Z',
      startAt: '2026-11-29T12:00:00.000Z',
      endAt: '2026-11-29T14:00:00.000Z',
    }),
    expect: [2],
  },
  {
    method: 'POST',
    path: `${W}/time-blocks/:id/skip`,
    params: (c) => ({ id: c.timeBlockId }),
    body: () => ({ originalStart: '2026-12-06T11:00:00.000Z' }),
    expect: [2],
  },
  // Travel: the owner's own. A leg may have gone with the occurrence skipped above (a 409 to edit).
  { method: 'GET', path: `${W}/travel/places`, expect: [2] },
  {
    method: 'POST',
    path: `${W}/travel/places`,
    body: () => ({ name: 'Technion', address: 'Technion City, Haifa' }),
    expect: [2],
  },
  {
    method: 'PATCH',
    path: `${W}/travel/places/:id`,
    params: (c) => ({ id: c.travel.placeId }),
    body: () => ({ aliases: ['ORT Braude'] }),
    expect: [2],
  },
  { method: 'GET', path: `${W}/travel/rules`, expect: [2] },
  {
    method: 'POST',
    path: `${W}/travel/rules`,
    body: (c) => ({
      scope: { kind: 'item', itemId: c.itemId, occurrence: 'single' },
      mode: 'drive',
      direction: 'there',
    }),
    expect: [2],
  },
  {
    method: 'PATCH',
    path: `${W}/travel/rules/:id`,
    params: (c) => ({ id: c.travel.ruleId }),
    body: () => ({ mode: 'drive' }),
    expect: [2],
  },
  { method: 'GET', path: `${W}/travel/settings`, expect: [2] },
  {
    method: 'PATCH',
    path: `${W}/travel/settings`,
    body: () => ({ goHome: { enabled: true } }),
    expect: [2],
  },
  {
    method: 'PUT',
    path: `${W}/travel/container-places/:containerId`,
    params: () => ({ containerId: 'cal-braude' }),
    body: (c) => ({ placeId: c.travel.placeId }),
    expect: [2],
  },
  {
    method: 'PUT',
    path: `${W}/travel/item-places/:itemId`,
    params: (c) => ({ itemId: c.itemId }),
    body: (c) => ({ placeId: c.travel.placeId }),
    expect: [2],
  },
  {
    method: 'POST',
    path: `${W}/travel/items/:itemId`,
    params: (c) => ({ itemId: c.timeBlockId }),
    body: (c) => ({ every: true, mode: 'transit', direction: 'both', placeId: c.travel.placeId }),
    expect: [2],
  },
  {
    method: 'POST',
    path: `${W}/travel/preview`,
    body: (c) => ({ mode: 'drive', toPlaceId: c.travel.placeId, arriveBy: '2026-11-29T11:00:00Z' }),
    expect: [2],
  },
  {
    method: 'PATCH',
    path: `${W}/travel/legs/:id`,
    params: (c) => ({ id: c.travel.legId }),
    body: () => ({ minutes: 30 }),
    expect: [2, 4],
  },
  {
    method: 'PUT',
    path: `${W}/travel/legs/:id/mode`,
    params: (c) => ({ id: c.travel.legId }),
    body: () => ({ mode: 'walk', scope: 'this' }),
    expect: [2, 4],
  },
  {
    method: 'GET',
    path: `${W}/travel/legs/:id/links`,
    params: (c) => ({ id: c.travel.legId }),
    expect: [2],
  },
  {
    method: 'POST',
    path: `${W}/travel/legs/:id/skip`,
    params: (c) => ({ id: c.travel.legId }),
    expect: [2],
    noBadInput: true,
  },
  {
    method: 'POST',
    path: `${W}/travel/legs/:id/reset`,
    params: (c) => ({ id: c.travel.legId }),
    expect: [2],
    noBadInput: true,
  },
  { method: 'GET', path: `${W}/travel/days`, query: 'from=2026-11-22&to=2026-11-28', expect: [2] },
  { method: 'GET', path: `${W}/facets`, expect: [2] },
  { method: 'POST', path: `${W}/query`, body: () => ({ draft: { source: 'items' } }), expect: [2] },

  // ── dashboards, builder, views ────────────────────────────────────────────
  { method: 'GET', path: `${W}/dashboards`, expect: [2] },
  {
    method: 'POST',
    path: `${W}/dashboards`,
    body: () => ({ title: 'Manifest dashboard' }),
    expect: [2],
  },
  { method: 'GET', path: `${W}/dashboards/:id`, params: dash, expect: [2] },
  {
    method: 'PATCH',
    path: `${W}/dashboards/:id`,
    params: dash,
    body: (c) => ({ ...versioned(c), title: 'Patched' }),
    expect: [2],
  },
  {
    method: 'PUT',
    path: `${W}/dashboards/:id/layout`,
    params: dash,
    body: (c) => ({ ...versioned(c), layouts: {} }),
    expect: [2, 4],
  },
  {
    method: 'POST',
    path: `${W}/dashboards/:id/ops`,
    params: dash,
    body: (c) => ({ ...versioned(c), ops: [{ op: 'set_title', title: 'Via ops' }] }),
    expect: [2],
  },
  { method: 'GET', path: `${W}/dashboards/:id/versions`, params: dash, expect: [2] },
  {
    method: 'POST',
    path: `${W}/dashboards/:id/undo`,
    params: dash,
    body: versioned,
    expect: [2, 4],
  },
  {
    method: 'POST',
    path: `${W}/dashboards/:id/redo`,
    params: dash,
    body: versioned,
    expect: [2, 4],
  },
  {
    method: 'POST',
    path: `${W}/dashboards/:id/revert`,
    params: dash,
    body: (c) => ({ ...versioned(c), toVersion: 1 }),
    expect: [2, 4],
  },
  {
    method: 'POST',
    path: `${W}/dashboards/:id/publish`,
    params: dash,
    body: versioned,
    expect: [2, 4],
  },
  { method: 'GET', path: `${W}/builder/catalog`, expect: [2] },
  { method: 'GET', path: `${W}/builder/templates`, expect: [2] },
  { method: 'GET', path: `${W}/builder/view-templates`, expect: [2] },
  { method: 'GET', path: `${W}/builder/personas`, expect: [2] },
  // Makes topics, pages and views from a persona; binds only the caller's own integrations.
  {
    method: 'POST',
    path: `${W}/builder/personas/:key/instantiate`,
    params: () => ({ key: 'light-student@1' }),
    body: () => ({ language: 'en' }),
    expect: [2],
  },
  {
    method: 'POST',
    path: `${W}/builder/validate`,
    body: () => ({ draft: { title: 'x', blocks: [] } }),
    expect: [2, 4],
  },
  {
    method: 'POST',
    path: `${W}/builder/instantiate`,
    body: () => ({ templateKey: 'dashboard' }),
    expect: [2],
  },
  // What instantiating would share: the caller's own integrations, id + provider + label only.
  {
    method: 'POST',
    path: `${W}/builder/template-shares`,
    body: () => ({ templateKeys: ['dashboard'] }),
    expect: [2],
  },
  { method: 'GET', path: `${W}/views`, expect: [2] },
  {
    method: 'POST',
    path: `${W}/views`,
    body: () => ({ title: 'Manifest view', query: { source: 'items' }, viz: { kind: 'list' } }),
    expect: [2],
  },
  { method: 'GET', path: `${W}/views/:id`, params: (c) => ({ id: c.viewId }), expect: [2] },
  {
    method: 'PATCH',
    path: `${W}/views/:id`,
    params: (c) => ({ id: c.viewId }),
    body: () => ({ title: 'Renamed view' }),
    expect: [2],
  },
  {
    method: 'DELETE',
    path: `${W}/views/:id`,
    params: (c) => ({ id: c.viewId }),
    expect: [2],
    noBadInput: true,
  },

  // ── agent keys ────────────────────────────────────────────────────────────
  { method: 'GET', path: `${W}/agent-keys`, expect: [2] },
  {
    method: 'POST',
    path: `${W}/agent-keys`,
    body: () => ({ name: 'Manifest key', scopes: ['read'] }),
    expect: [2],
  },

  // MCP sign-in consent: an unknown request is a 404, so the routes answer without a secret.
  {
    method: 'GET',
    path: `${P}/mcp-oauth/requests/:id`,
    params: () => ({ id: 'unknown-request' }),
    expect: [4],
  },
  {
    method: 'POST',
    path: `${P}/mcp-oauth/requests/:id/approve`,
    params: () => ({ id: 'unknown-request' }),
    body: (c) => ({ workspaceId: c.wid, scopes: ['read'], name: 'Manifest agent' }),
    expect: [4],
  },
  {
    method: 'POST',
    path: `${P}/mcp-oauth/requests/:id/deny`,
    params: () => ({ id: 'unknown-request' }),
    expect: [4],
    noBadInput: true,
  },

  // ── integrations and sync ─────────────────────────────────────────────────
  { method: 'GET', path: `${W}/integrations`, expect: [2] },
  // Which of the caller's own integrations are on a block: `{shared: ids}` only.
  { method: 'GET', path: `${W}/integrations/sharing`, expect: [2] },
  {
    method: 'POST',
    path: `${W}/integrations`,
    body: () => ({ provider: 'linear', config: {} }),
    expect: [2, 4],
  },
  { method: 'GET', path: `${W}/integrations/:iid/config`, params: jira, expect: [2] },
  {
    method: 'PATCH',
    path: `${W}/integrations/:iid`,
    params: jira,
    body: () => ({ label: 'Renamed integration' }),
    expect: [2],
  },
  { method: 'POST', path: `${W}/integrations/:iid/test`, params: jira, expect: [2, 4] },
  // 409 oauth_unavailable without a Google OAuth client; else 200 `{authorizeUrl}` + a cookie.
  {
    method: 'POST',
    path: `${W}/integrations/google-calendar/oauth/start`,
    body: () => ({ lng: 'en' }),
    expect: [2, 4],
  },
  // OAuth sign-in for the other providers: 409 oauth_unavailable without an app secret, else 200
  // `{authorizeUrl}` + a cookie; the listing carries setup information, never a secret.
  {
    method: 'POST',
    path: `${W}/integrations/oauth/:provider/start`,
    params: () => ({ provider: 'linear' }),
    body: () => ({ lng: 'en' }),
    expect: [2, 4],
  },
  { method: 'GET', path: `${W}/integrations/oauth/providers`, expect: [2] },
  // Only a Jira or ClickUp connected with OAuth lists its resources: 409 for the token Jira one.
  { method: 'GET', path: `${W}/integrations/:iid/oauth/resources`, params: jira, expect: [4] },
  // Only a Google Calendar connected with Google lists its calendars: 409 for the Jira one.
  { method: 'GET', path: `${W}/integrations/:iid/calendars`, params: jira, expect: [4] },
  { method: 'POST', path: `${W}/integrations/:iid/sync`, params: jira, expect: [2, 4] },
  // PERMISSIONS-V2 "Stop sharing": the connector comes off every block; `{dashboards}` only.
  {
    method: 'POST',
    path: `${W}/integrations/:iid/stop-sharing`,
    params: jira,
    expect: [2],
    noBadInput: true,
  },
  // File under: a container that is not there is 404, and nothing is written.
  {
    method: 'PUT',
    path: `${W}/integrations/:iid/containers/:cid/file-under`,
    params: (c) => ({ iid: c.integrations.jira, cid: 'no-such-container' }),
    body: () => ({ topicId: null }),
    expect: [4],
  },
  // Only a Google Calendar pushes events: 400 for the Jira one (and nothing is removed).
  {
    method: 'POST',
    path: `${W}/integrations/:iid/remove-pushed`,
    params: jira,
    expect: [4],
    noBadInput: true,
  },
  { method: 'POST', path: `${W}/sync`, expect: [2] },
  { method: 'GET', path: `${W}/sync-runs`, expect: [2] },
  {
    method: 'POST',
    path: `${W}/gcal-sync`,
    body: (c) => ({ integrationId: c.integrations.gcal }),
    expect: [2, 4],
  },
  // The workspace's primary calendar: any member reads its state (ids to its owner only); a
  // workspace owner sets it (the seeded Google Calendar is read-only and never reached Google:
  // 4xx) or clears it.
  { method: 'GET', path: `${W}/primary-calendar`, expect: [2] },
  {
    method: 'PUT',
    path: `${W}/primary-calendar`,
    body: (c) => ({ integrationId: c.integrations.gcal, calendarId: 'primary' }),
    expect: [2, 4],
  },
  { method: 'DELETE', path: `${W}/primary-calendar`, expect: [2], noBadInput: true },
  {
    method: 'POST',
    path: `${W}/connect-links/consume`,
    body: () => ({ link: 'manifest-link-0123456789' }),
    expect: [4],
  },
  // The credential route: 204 for a valid body (a rotation here), a generic 400 otherwise.
  {
    method: 'PUT',
    path: `${W}/integrations/:iid/credential`,
    params: jira,
    body: () => ({
      email: 'jira-account@example.test',
      token: ['ATATT3x', 'FAKE', '0123456789abcdefghijKLMN'].join(''),
    }),
    expect: [2],
  },

  // ── destructive: last, on what the suite created for it ───────────────────
  {
    method: 'DELETE',
    path: `${W}/travel/items/:itemId`,
    params: (c) => ({ itemId: c.timeBlockId }),
    query: 'every=true',
    expect: [2],
    noBadInput: true,
  },
  {
    method: 'DELETE',
    path: `${W}/travel/rules/:id`,
    params: (c) => ({ id: c.travel.ruleId }),
    expect: [2],
    noBadInput: true,
  },
  {
    method: 'DELETE',
    path: `${W}/travel/places/:id`,
    params: (c) => ({ id: c.travel.placeId }),
    expect: [2],
    noBadInput: true,
  },
  {
    method: 'DELETE',
    path: `${W}/items/:id`,
    params: item,
    expect: [2],
    noBadInput: true,
  },
  {
    method: 'DELETE',
    path: `${W}/dashboards/:id`,
    params: dash,
    expect: [2],
    noBadInput: true,
  },
  {
    method: 'DELETE',
    path: `${W}/agent-keys/:id`,
    params: (c) => ({ id: c.agentKeyId }),
    expect: [2],
    noBadInput: true,
  },
  {
    method: 'DELETE',
    path: `${W}/integrations/:iid`,
    params: (c) => ({ iid: c.integrations.clickup }),
    expect: [2],
    noBadInput: true,
  },
  {
    method: 'DELETE',
    path: `${W}/topics/:tid`,
    params: (c) => ({ tid: c.topicId }),
    expect: [2],
    noBadInput: true,
  },
  { method: 'DELETE', path: `${W}/members/me`, as: 'member', expect: [2], noBadInput: true },
  {
    method: 'DELETE',
    path: `${W}/members/:uid`,
    params: (c) => ({ uid: c.memberIds.removed }),
    expect: [2],
    noBadInput: true,
  },
  {
    method: 'DELETE',
    path: W,
    as: 'throwaway',
    params: (c) => ({ wid: c.throwawayWid }),
    expect: [2],
    noBadInput: true,
  },
  { method: 'DELETE', path: `${P}/delete`, as: 'throwaway', expect: [2], noBadInput: true },
];

/** Mounts other suites own: MCP (T6.x). Never called here. */
export const EXEMPT_MOUNTS: readonly { prefix: string; reason: string }[] = [
  {
    prefix: '/api/mcp',
    reason: 'authenticated by agent keys, not by a session; its own suite (MCP, T6.x) covers it',
  },
  {
    prefix: '/api/mcp/oauth',
    reason:
      'MCP sign-in: public OAuth endpoints whose job is to answer codes and tokens (RFC 6749 wire format); mcp/__tests__/oauth.http.test.ts covers them',
  },
  {
    prefix: '/.well-known',
    reason: 'public discovery documents (RFC 8414, RFC 9728): no secret, no session',
  },
];
