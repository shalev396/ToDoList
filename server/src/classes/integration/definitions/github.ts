/**
 * GitHub (GitHubIntegration's definition): issues and pull requests of the account's repositories,
 * and its Projects boards. Its OAuth app is a GitHub App (PKCE S256, no scopes: the app's
 * permissions decide; access token 8 h, rotating refresh token 6 months); a fine-grained personal
 * access token (and an optional second one for Projects boards) is the fallback.
 */
import { z } from 'zod';

import { githubOptions } from '../../../services/providerCreate/funnel.js';
import { ProviderHttpError } from '../../../sync/http.js';
import { GITHUB_API, githubAdapter } from '../../../sync/providers/github.js';
import { ApiKeyAuth, type ApiKeyAuthOptions } from '../auth/ApiKeyAuth.js';
import { OAuthAuth, type OAuthAppOptions } from '../auth/OAuthAuth.js';
import { ALNUM, FAKE_MARK, filler, UPPER_ALNUM } from './fake.js';
import { GitHubLogin, Token } from './fields.js';
import { IntegrationDefinition, type DefinitionSpec } from './IntegrationDefinition.js';

/** `{accessToken, refreshToken, …}` (OAuth) or `{token, projectsToken?}` (personal tokens). */
export type GitHubSecret = Readonly<{
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  scope?: string;
  token?: string;
  projectsToken?: string;
}>;

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/) });

const githubApp: OAuthAppOptions = {
  provider: 'github',
  secretName: 'oauth-github',
  endpoints: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    revoke: null,
    api: GITHUB_API,
  },
  callbackPath: '/api/public/oauth/github/callback',
  scopes: [],
  pkce: true,
  sendResponseType: false,
  refresh: 'stored',
  consoleUrl: 'https://github.com/settings/apps/new',
  async identify(client, accessToken) {
    const { data } = await client.getJson<unknown>(`${GITHUB_OAUTH.endpoints().api}/user`, {
      ...GITHUB_OAUTH.headers({ accessToken }),
      accept: 'application/vnd.github+json',
      'user-agent': 'TodoList',
    });
    const parsed = GithubUser.safeParse(data);
    if (!parsed.success) throw new ProviderHttpError('github', null, 'bad_response');
    const { login } = parsed.data;
    return {
      accountId: login.toLowerCase(),
      label: login,
      // A user's own repositories are personal (GitHubIntegration adds the topic rule).
      config: { owner: login, ownerType: 'user' },
      topicSlug: 'personal',
    };
  },
  installUrl: (credentials) =>
    credentials?.appSlug === undefined
      ? 'https://github.com/settings/installations'
      : `https://github.com/apps/${credentials.appSlug}/installations/new`,
  // After an install with "Request user authorization during installation", GitHub starts the
  // web flow itself, with a code and no state of ours: the user only lands back on the page.
  landsWithoutState: (query) =>
    query['state'] === undefined &&
    (query['installation_id'] !== undefined || query['setup_action'] !== undefined),
};

export const GITHUB_OAUTH = new OAuthAuth<GitHubSecret>(githubApp);

const githubToken: ApiKeyAuthOptions<GitHubSecret> = {
  methods: ['fine_grained_pat'],
  // Boards are read with `projectsToken` when there is one, everything else with `token`.
  headers: (secret, purpose) => {
    const projects = secret.projectsToken;
    const token =
      purpose === 'boards' && projects !== undefined && projects !== ''
        ? projects
        : (secret.token ?? '');
    return { authorization: `Bearer ${token}` };
  },
  credential: {
    schema: z.strictObject({ token: Token, projectsToken: Token.optional() }),
    fake: (name) => ({
      token: `github_pat_11${FAKE_MARK}${filler(name, 'id', 18, UPPER_ALNUM)}_${filler(name, 'token', 59, ALNUM)}`,
    }),
  },
};

export const GITHUB_TOKEN = new ApiKeyAuth<GitHubSecret>(githubToken);

const ownerOf = (config: Record<string, unknown>): string | null => {
  const owner = config['owner'];
  return typeof owner === 'string' ? owner : null;
};

const github: DefinitionSpec<
  GitHubSecret,
  { oauth: OAuthAuth<GitHubSecret>; apiKey: ApiKeyAuth<GitHubSecret> }
> = {
  provider: 'github',
  auth: { oauth: GITHUB_OAUTH, apiKey: GITHUB_TOKEN },
  config: () =>
    z.strictObject({
      owner: GitHubLogin,
      ownerType: z.enum(['user', 'org']),
      repos: z
        .strictObject({
          include: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
          forks: z.boolean().optional(),
          archived: z.boolean().optional(),
        })
        .optional(),
      issues: z
        .strictObject({
          // What the GitHub adapter reads: issues assigned to, or opened by, the account.
          involvement: z
            .array(z.enum(['assigned', 'created']))
            .min(1)
            .max(2)
            .optional(),
          closedWithinDays: z.int().min(0).max(365).optional(),
        })
        .optional(),
      boards: z
        .strictObject({
          /** Off when the token can't read Projects boards (set by a connection test). */
          enabled: z.boolean().optional(),
          /** Board numbers, or title globs. */
          include: z
            .array(z.union([z.int().positive(), z.string().trim().min(1).max(200)]))
            .max(50)
            .optional(),
          dueField: z.string().trim().min(1).max(100).optional(),
        })
        .optional(),
    }),
  connection: {
    topic: (config) => (config['ownerType'] === 'user' ? 'personal' : 'work'),
    accountId: (config) => ownerOf(config)?.toLowerCase() ?? null,
    label: ownerOf,
    movedAccount: (integration, config) => {
      if (ownerOf(config)?.toLowerCase() !== integration.accountId) return 'owner';
      if (config['ownerType'] !== integration.config['ownerType']) return 'ownerType';
      return null;
    },
  },
  adapter: githubAdapter,
  create: {
    steps: ['repo', 'label'],
    authKinds: ['oauth', 'api_key'],
    linkAllowed: (host) => host === 'github.com' || host.endsWith('.github.com'),
    // A GitHub App refusing is a permission the user grants in the app's settings.
    forbiddenWithOAuth: 'needs_permission',
    readOptions: githubOptions,
  },
  // An issue's title and state (open; closed as completed or not planned). Its due date comes from
  // a board or a milestone, and "in progress" from a board column: neither is the issue's own.
  // Pull requests and board drafts take no write-back.
  write: { fields: ['title', 'status'], kinds: ['issue'] },
  revokePage: 'https://github.com/settings/apps/authorizations',
  fixtures: { createOptions: 'create-options' },
};

export const GITHUB = new IntegrationDefinition(github);
