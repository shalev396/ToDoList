/**
 * The OAuth providers besides Google Calendar: what each one asks for and how it names the
 * connected account. Everything specific to a provider is here, so the flow (service.ts), the
 * routes and the integration rules (Integration.connectOAuth) stay generic.
 *
 * Endpoints, parameters and lifetimes verified against the providers' documentation
 * (INTEGRATIONS-SETUP.md):
 * - GitHub App: authorize/token at github.com/login/oauth, PKCE S256, no scopes (the app's
 *   permissions decide), access token 8 h, rotating refresh token 6 months.
 * - Atlassian 3LO: auth.atlassian.com, `audience=api.atlassian.com`, `offline_access` for a
 *   rotating refresh token (90 days unused, 10-minute reuse leeway), JSON token requests, no PKCE.
 * - ClickUp: app.clickup.com/api, a token that does not expire, no refresh, no scopes, no PKCE.
 * - Linear: PKCE, `read` scope, access token 24 h, rotating refresh token 30 days.
 */
import { z } from 'zod';

import { ProviderHttpError, type ReadOnlyClient } from '../../sync/http.js';
import { oauthEndpoints, type OAuthProviderId } from '../../sync/providers/oauthEndpoints.js';
import type { AppSecretName } from '../appSecrets.js';

/** What identify() learns: the account key and label, and the settings a new integration starts with. */
export interface ProviderIdentity {
  accountId: string;
  label: string;
  config: Record<string, unknown>;
  /** The default topic (slug) a new connection starts in. */
  topicSlug: string;
}

export interface OAuthProviderDef {
  id: OAuthProviderId;
  /** The app secret holding `{clientId, clientSecret}`. */
  secretName: AppSecretName;
  /** Requested on every connection: read-only. */
  scopes: readonly string[];
  /** Asked for later, by re-consent, when the user enables writing (H5). Not requested now. */
  writeScopes: readonly string[];
  pkce: boolean;
  /** Sent with `response_type=code`; GitHub's and ClickUp's authorize pages take none. */
  sendResponseType: boolean;
  /** Extra authorize parameters. */
  authorizeParams: Readonly<Record<string, string>>;
  /** Token requests as JSON (Atlassian) or a form. */
  tokenFormat: 'form' | 'json';
  /** The access token expires, so the grant must carry a refresh token. */
  refreshRequired: boolean;
  /** Where the operator registers the OAuth app. */
  consoleUrl: string;
  identify(client: ReadOnlyClient, accessToken: string): Promise<ProviderIdentity>;
}

const bearer = (accessToken: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
});

const badAnswer = (provider: OAuthProviderId): ProviderHttpError =>
  new ProviderHttpError(provider, null, 'bad_response');

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/) });
const AtlassianMe = z.object({
  account_id: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/),
  email: z.string().max(254).optional(),
  name: z.string().max(200).optional(),
});
const AtlassianResources = z.array(
  z.object({
    id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    url: z.string().max(2048),
    name: z.string().min(1).max(200),
    scopes: z.array(z.string()).optional(),
  }),
);
const ClickUpUser = z.object({
  user: z.object({
    id: z.union([z.number().int(), z.string().regex(/^\d{1,20}$/)]),
    username: z.string().max(200).optional(),
    email: z.string().max(254).optional(),
  }),
});
const LinearViewer = z.object({
  viewer: z.object({
    id: z.string().min(1).max(100),
    name: z.string().max(200).optional(),
    email: z.string().max(254).optional(),
  }),
});

/** One Jira site the grant can read. */
export interface JiraSiteInfo {
  cloudId: string;
  url: string;
  name: string;
}

/** The Jira sites of a grant: accessible resources that carry a Jira scope. */
export async function jiraAccessibleSites(
  client: ReadOnlyClient,
  accessToken: string,
): Promise<JiraSiteInfo[]> {
  const { data } = await client.getJson<unknown>(
    `${oauthEndpoints('jira').api}/oauth/token/accessible-resources`,
    bearer(accessToken),
  );
  const parsed = AtlassianResources.safeParse(data);
  if (!parsed.success) throw badAnswer('jira');
  return parsed.data
    .filter(
      (site) => site.scopes === undefined || site.scopes.some((scope) => scope.includes('jira')),
    )
    .map((site) => ({ cloudId: site.id, url: site.url.replace(/\/+$/, ''), name: site.name }));
}

/** The ClickUp workspaces a grant can read. */
export async function clickupTeams(
  client: ReadOnlyClient,
  accessToken: string,
): Promise<{ id: string; name: string }[]> {
  const { data } = await client.getJson<{ teams?: unknown }>(
    `${oauthEndpoints('clickup').api}/team`,
    bearer(accessToken),
  );
  const teams = Array.isArray(data.teams) ? (data.teams as unknown[]) : [];
  const out: { id: string; name: string }[] = [];
  for (const team of teams) {
    const { id, name } = (team ?? {}) as { id?: unknown; name?: unknown };
    if ((typeof id === 'string' || typeof id === 'number') && /^\d{1,20}$/.test(String(id))) {
      out.push({
        id: String(id),
        name: typeof name === 'string' ? name.slice(0, 200) : String(id),
      });
    }
  }
  return out;
}

/** The GraphQL document the Linear identity step sends (registered on its client). */
export const LINEAR_VIEWER_DOCUMENT = 'query Viewer { viewer { id name email } }';

export const OAUTH_PROVIDER_DEFS: Readonly<Record<OAuthProviderId, OAuthProviderDef>> = {
  github: {
    id: 'github',
    secretName: 'oauth-github',
    scopes: [],
    writeScopes: [],
    pkce: true,
    sendResponseType: false,
    authorizeParams: {},
    tokenFormat: 'form',
    refreshRequired: false,
    consoleUrl: 'https://github.com/settings/apps/new',
    async identify(client, accessToken) {
      const { data } = await client.getJson<unknown>(`${oauthEndpoints('github').api}/user`, {
        ...bearer(accessToken),
        accept: 'application/vnd.github+json',
        'user-agent': 'TodoList',
      });
      const parsed = GithubUser.safeParse(data);
      if (!parsed.success) throw badAnswer('github');
      const { login } = parsed.data;
      return {
        accountId: login.toLowerCase(),
        label: login,
        // A user's own repositories are personal (GitHubIntegration adds the topic rule).
        config: { owner: login, ownerType: 'user' },
        topicSlug: 'personal',
      };
    },
  },
  jira: {
    id: 'jira',
    secretName: 'oauth-jira',
    scopes: ['read:jira-work', 'read:jira-user', 'read:me', 'offline_access'],
    writeScopes: ['write:jira-work'],
    pkce: false,
    sendResponseType: true,
    authorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    tokenFormat: 'json',
    refreshRequired: true,
    consoleUrl: 'https://developer.atlassian.com/console/myapps/',
    async identify(client, accessToken) {
      const { data } = await client.getJson<unknown>(
        `${oauthEndpoints('jira').api}/me`,
        bearer(accessToken),
      );
      const me = AtlassianMe.safeParse(data);
      if (!me.success) throw badAnswer('jira');
      const sites = await jiraAccessibleSites(client, accessToken);
      if (sites.length === 0) throw badAnswer('jira');
      return {
        accountId: me.data.account_id,
        label: me.data.email ?? me.data.name ?? 'Jira',
        // Every site of the grant, until its owner narrows them down.
        config: { sites },
        topicSlug: 'work',
      };
    },
  },
  clickup: {
    id: 'clickup',
    secretName: 'oauth-clickup',
    scopes: [],
    writeScopes: [],
    pkce: false,
    sendResponseType: false,
    authorizeParams: {},
    tokenFormat: 'form',
    refreshRequired: false,
    consoleUrl: 'https://app.clickup.com/settings/apps',
    async identify(client, accessToken) {
      const { data } = await client.getJson<unknown>(
        `${oauthEndpoints('clickup').api}/user`,
        bearer(accessToken),
      );
      const parsed = ClickUpUser.safeParse(data);
      if (!parsed.success) throw badAnswer('clickup');
      const { user } = parsed.data;
      const teams = await clickupTeams(client, accessToken);
      return {
        accountId: String(user.id),
        label: user.username ?? user.email ?? 'ClickUp',
        config: { teamIds: teams.map((team) => team.id) },
        topicSlug: 'work',
      };
    },
  },
  linear: {
    id: 'linear',
    secretName: 'oauth-linear',
    scopes: ['read'],
    writeScopes: ['issues:create'],
    pkce: true,
    sendResponseType: true,
    authorizeParams: {},
    tokenFormat: 'form',
    refreshRequired: true,
    consoleUrl: 'https://linear.app/settings/api/applications/new',
    async identify(client, accessToken) {
      const data = await client.graphql<unknown>('Viewer', {}, bearer(accessToken));
      const parsed = LinearViewer.safeParse(data);
      if (!parsed.success) throw badAnswer('linear');
      const { viewer } = parsed.data;
      return {
        accountId: viewer.id,
        label: viewer.name ?? viewer.email ?? 'Linear',
        config: {},
        topicSlug: 'personal',
      };
    },
  },
};

export function isOAuthProviderId(value: unknown): value is OAuthProviderId {
  return typeof value === 'string' && Object.hasOwn(OAUTH_PROVIDER_DEFS, value);
}
