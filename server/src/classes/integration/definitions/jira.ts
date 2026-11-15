/**
 * Jira (JiraIntegration's definition): issues of one or more sites. An OAuth grant (Atlassian 3LO:
 * `audience=api.atlassian.com`, `offline_access` for a rotating refresh token, JSON token
 * requests, no PKCE) reads the sites its owner picks through Atlassian's gateway; an API token
 * (Basic email:token) reads its one site.
 */
import { z } from 'zod';

import { ProviderHttpError, type ReadOnlyClient } from '../../../sync/http.js';
import { ATLASSIAN_API, jiraAdapter } from '../../../sync/providers/jira.js';
import { jiraOptions } from '../../../services/providerCreate/funnel.js';
import { jiraSitesOf } from '../../../services/providerCreate/jiraSites.js';
import { ApiKeyAuth, type ApiKeyAuthOptions } from '../auth/ApiKeyAuth.js';
import { OAuthAuth, type OAuthAppOptions } from '../auth/OAuthAuth.js';
import { ALNUM, FAKE_MARK, fakeEmail, filler } from './fake.js';
import { Email, hostOf, httpsUrl, Token } from './fields.js';
import { IntegrationDefinition, type DefinitionSpec } from './IntegrationDefinition.js';

/** `{accessToken, refreshToken, …}` (OAuth) or `{email, token}` (an API token). */
export type JiraSecret = Readonly<{
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  scope?: string;
  email?: string;
  token?: string;
}>;

/** One Jira site the grant can read. */
export interface JiraSiteInfo {
  cloudId: string;
  url: string;
  name: string;
}

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

const badAnswer = (): ProviderHttpError => new ProviderHttpError('jira', null, 'bad_response');

/** The Jira sites of a grant: accessible resources that carry a Jira scope. */
export async function jiraAccessibleSites(
  client: ReadOnlyClient,
  auth: Readonly<Record<string, string>>,
): Promise<JiraSiteInfo[]> {
  const { data } = await client.getJson<unknown>(
    `${JIRA_OAUTH.endpoints().api}/oauth/token/accessible-resources`,
    auth,
  );
  const parsed = AtlassianResources.safeParse(data);
  if (!parsed.success) throw badAnswer();
  return parsed.data
    .filter(
      (site) => site.scopes === undefined || site.scopes.some((scope) => scope.includes('jira')),
    )
    .map((site) => ({ cloudId: site.id, url: site.url.replace(/\/+$/, ''), name: site.name }));
}

const jiraApp: OAuthAppOptions = {
  provider: 'jira',
  secretName: 'oauth-jira',
  endpoints: {
    authorize: 'https://auth.atlassian.com/authorize',
    token: 'https://auth.atlassian.com/oauth/token',
    revoke: null,
    api: ATLASSIAN_API,
  },
  callbackPath: '/api/public/oauth/jira/callback',
  scopes: ['read:jira-work', 'read:jira-user', 'read:me', 'offline_access'],
  writeScopes: ['write:jira-work'],
  pkce: false,
  sendResponseType: true,
  authorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
  tokenFormat: 'json',
  refresh: 'stored',
  refreshRequired: true,
  consoleUrl: 'https://developer.atlassian.com/console/myapps/',
  async identify(client, accessToken) {
    // The fresh grant's headers, as its strategy builds them.
    const auth = JIRA_OAUTH.headers({ accessToken });
    const { data } = await client.getJson<unknown>(`${JIRA_OAUTH.endpoints().api}/me`, auth);
    const me = AtlassianMe.safeParse(data);
    if (!me.success) throw badAnswer();
    const sites = await jiraAccessibleSites(client, auth);
    if (sites.length === 0) throw badAnswer();
    return {
      accountId: me.data.account_id,
      label: me.data.email ?? me.data.name ?? 'Jira',
      // Every site of the grant, until its owner narrows them down.
      config: { sites },
      topicSlug: 'work',
    };
  },
};

export const JIRA_OAUTH = new OAuthAuth<JiraSecret>(jiraApp);

const jiraToken: ApiKeyAuthOptions<JiraSecret> = {
  methods: ['api_token_basic'],
  headers: (secret) => ({
    authorization: `Basic ${Buffer.from(`${secret.email ?? ''}:${secret.token ?? ''}`).toString('base64')}`,
  }),
  credential: {
    schema: z.strictObject({ email: Email, token: Token }),
    fake: (name) => ({
      email: fakeEmail(name, 'example.invalid'),
      token: `ATATT3x${FAKE_MARK}${filler(name, 'token', 64, ALNUM)}`,
    }),
  },
};

export const JIRA_API_TOKEN = new ApiKeyAuth<JiraSecret>(jiraToken);

const hostname = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const jira: DefinitionSpec<
  JiraSecret,
  { oauth: OAuthAuth<JiraSecret>; apiKey: ApiKeyAuth<JiraSecret> }
> = {
  provider: 'jira',
  auth: { oauth: JIRA_OAUTH, apiKey: JIRA_API_TOKEN },
  // A token integration names its site (`baseUrl`); an OAuth one lists the sites its one grant
  // reads (`sites`, chosen from the grant's accessible resources): exactly one of the two.
  config: (allowLocal) =>
    z
      .strictObject({
        baseUrl: httpsUrl(allowLocal).optional(),
        sites: z
          .array(
            z.strictObject({
              cloudId: z
                .string()
                .trim()
                .regex(/^[A-Za-z0-9-]{8,64}$/, 'Must be an Atlassian cloud id'),
              url: httpsUrl(allowLocal),
              name: z.string().trim().min(1).max(200),
            }),
          )
          .min(1)
          .max(20)
          .refine(
            (sites) => new Set(sites.map(({ cloudId }) => cloudId)).size === sites.length,
            'Sites must differ',
          )
          .optional(),
        jql: z.string().trim().min(1).max(2000).optional(),
      })
      .refine((config) => (config.baseUrl === undefined) !== (config.sites === undefined), {
        message: 'Give a baseUrl, or the sites of an OAuth connection',
        path: ['baseUrl'],
      }),
  connection: {
    topic: () => 'work',
    accountId: (config) => hostOf(config['baseUrl']),
    label: (config) => hostOf(config['baseUrl']),
    requiredForKey: 'baseUrl',
    // An OAuth connection is its grant: it names sites, not a site host.
    movedAccount: (integration, config) =>
      integration.authKind === 'oauth'
        ? config['baseUrl'] === undefined
          ? null
          : 'baseUrl'
        : hostOf(config['baseUrl']) === integration.accountId
          ? null
          : 'baseUrl',
  },
  adapter: jiraAdapter,
  create: {
    steps: ['site', 'project', 'issueType', 'team'],
    authKinds: ['oauth', 'api_key'],
    linkAllowed: (host, integration) =>
      jiraSitesOf(integration).some((site) => hostname(site.siteUrl) === host),
    forbiddenWithOAuth: 'rejected',
    readOptions: jiraOptions,
  },
  // An issue's summary, status (a transition), due date (a date) and priority (by its default
  // name). Jira has no start date; a description is kept here only as a preview.
  write: { fields: ['title', 'status', 'dueAt', 'priority'], kinds: ['issue'] },
  picker: 'sites',
  revokePage: 'https://id.atlassian.com/manage-profile/apps',
  fixtures: { createOptions: 'create-options' },
};

export const JIRA = new IntegrationDefinition(jira);
