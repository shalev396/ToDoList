/**
 * ClickUp (ClickUpIntegration's definition): the tasks of the chosen workspaces' lists. Its OAuth
 * app (app.clickup.com/api) gives a token that does not expire: no refresh, no scopes, no PKCE. A
 * personal token goes as is.
 */
import { z } from 'zod';

import { clickupOptions } from '../../../services/providerCreate/funnel.js';
import { ProviderHttpError, type ReadOnlyClient } from '../../../sync/http.js';
import { CLICKUP_API, clickupAdapter } from '../../../sync/providers/clickup.js';
import { ApiKeyAuth, type ApiKeyAuthOptions } from '../auth/ApiKeyAuth.js';
import { OAuthAuth, type OAuthAppOptions } from '../auth/OAuthAuth.js';
import { DIGITS, FAKE_MARK, filler, UPPER_ALNUM } from './fake.js';
import { Token } from './fields.js';
import { IntegrationDefinition, type DefinitionSpec } from './IntegrationDefinition.js';

/** `{accessToken, …}` (OAuth) or `{token}` (a personal token). */
export type ClickUpSecret = Readonly<{ accessToken?: string; scope?: string; token?: string }>;

const ClickUpUser = z.object({
  user: z.object({
    id: z.union([z.number().int(), z.string().regex(/^\d{1,20}$/)]),
    username: z.string().max(200).optional(),
    email: z.string().max(254).optional(),
  }),
});

/** The ClickUp workspaces a grant can read. */
export async function clickupTeams(
  client: ReadOnlyClient,
  auth: Readonly<Record<string, string>>,
): Promise<{ id: string; name: string }[]> {
  const { data } = await client.getJson<{ teams?: unknown }>(
    `${CLICKUP_OAUTH.endpoints().api}/team`,
    auth,
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

const clickupApp: OAuthAppOptions = {
  provider: 'clickup',
  secretName: 'oauth-clickup',
  endpoints: {
    authorize: 'https://app.clickup.com/api',
    token: 'https://api.clickup.com/api/v2/oauth/token',
    revoke: null,
    api: CLICKUP_API,
  },
  callbackPath: '/api/public/oauth/clickup/callback',
  scopes: [],
  pkce: false,
  sendResponseType: false,
  refresh: 'stored',
  consoleUrl: 'https://app.clickup.com/settings/apps',
  async identify(client, accessToken) {
    // The fresh grant's headers, as its strategy builds them.
    const auth = CLICKUP_OAUTH.headers({ accessToken });
    const { data } = await client.getJson<unknown>(`${CLICKUP_OAUTH.endpoints().api}/user`, auth);
    const parsed = ClickUpUser.safeParse(data);
    if (!parsed.success) throw new ProviderHttpError('clickup', null, 'bad_response');
    const { user } = parsed.data;
    const teams = await clickupTeams(client, auth);
    return {
      accountId: String(user.id),
      label: user.username ?? user.email ?? 'ClickUp',
      config: { teamIds: teams.map((team) => team.id) },
      topicSlug: 'work',
    };
  },
};

export const CLICKUP_OAUTH = new OAuthAuth<ClickUpSecret>(clickupApp);

const clickupToken: ApiKeyAuthOptions<ClickUpSecret> = {
  methods: ['personal_token'],
  // The personal token as it is.
  headers: (secret) => ({ authorization: secret.token ?? '' }),
  credential: {
    schema: z.strictObject({ token: Token }),
    fake: (name) => ({
      token: `pk_${filler(name, 'user', 8, DIGITS)}_${FAKE_MARK}${filler(name, 'token', 28, UPPER_ALNUM)}`,
    }),
  },
};

export const CLICKUP_TOKEN = new ApiKeyAuth<ClickUpSecret>(clickupToken);

const on = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

const clickup: DefinitionSpec<
  ClickUpSecret,
  { oauth: OAuthAuth<ClickUpSecret>; apiKey: ApiKeyAuth<ClickUpSecret> }
> = {
  provider: 'clickup',
  auth: { oauth: CLICKUP_OAUTH, apiKey: CLICKUP_TOKEN },
  // `teamIds`: the workspaces an OAuth connection reads (all when absent).
  config: () =>
    z.strictObject({
      teamIds: z
        .array(z.string().regex(/^\d{1,20}$/, 'Must be a workspace id'))
        .max(50)
        .optional(),
    }),
  connection: { topic: () => 'work', accountId: () => null, label: () => null },
  adapter: clickupAdapter,
  create: {
    steps: ['workspace', 'space', 'folder', 'list'],
    authKinds: ['oauth', 'api_key'],
    linkAllowed: (host) => on(host, 'clickup.com'),
    forbiddenWithOAuth: 'rejected',
    readOptions: clickupOptions,
  },
  picker: 'workspaces',
  revokePage: 'https://app.clickup.com/settings/apps',
  fixtures: { createOptions: 'create-options' },
};

export const CLICKUP = new IntegrationDefinition(clickup);
