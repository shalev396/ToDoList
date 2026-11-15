/**
 * Linear (LinearIntegration's definition): issues through its GraphQL API (allow-listed documents
 * only). Its OAuth app: PKCE, the `read` scope (comma separated), access token 24 h, rotating
 * refresh token 30 days, a revocation endpoint. A personal API key goes as is.
 */
import { z } from 'zod';

import { linearOptions } from '../../../services/providerCreate/funnel.js';
import { ProviderHttpError } from '../../../sync/http.js';
import { LINEAR_API, linearAdapter } from '../../../sync/providers/linear.js';
import { ApiKeyAuth, type ApiKeyAuthOptions } from '../auth/ApiKeyAuth.js';
import { OAuthAuth, type OAuthAppOptions } from '../auth/OAuthAuth.js';
import { ALNUM, FAKE_MARK, filler } from './fake.js';
import { Token } from './fields.js';
import { IntegrationDefinition, type DefinitionSpec } from './IntegrationDefinition.js';

/** `{accessToken, refreshToken, …}` (OAuth) or `{apiKey}` (a personal API key). */
export type LinearSecret = Readonly<{
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  scope?: string;
  apiKey?: string;
}>;

/** The GraphQL document the Linear identity step sends (registered on its client). */
export const LINEAR_VIEWER_DOCUMENT = 'query Viewer { viewer { id name email } }';

const LinearViewer = z.object({
  viewer: z.object({
    id: z.string().min(1).max(100),
    name: z.string().max(200).optional(),
    email: z.string().max(254).optional(),
  }),
});

const linearApp: OAuthAppOptions = {
  provider: 'linear',
  secretName: 'oauth-linear',
  endpoints: {
    authorize: 'https://linear.app/oauth/authorize',
    token: 'https://api.linear.app/oauth/token',
    revoke: 'https://api.linear.app/oauth/revoke',
    api: LINEAR_API,
  },
  callbackPath: '/api/public/oauth/linear/callback',
  scopes: ['read'],
  writeScopes: ['issues:create'],
  scopeSeparator: ',',
  pkce: true,
  sendResponseType: true,
  refresh: 'stored',
  refreshRequired: true,
  consoleUrl: 'https://linear.app/settings/api/applications/new',
  identityDocuments: { Viewer: LINEAR_VIEWER_DOCUMENT },
  async identify(client, accessToken) {
    const data = await client.graphql<unknown>('Viewer', {}, LINEAR_OAUTH.headers({ accessToken }));
    const parsed = LinearViewer.safeParse(data);
    if (!parsed.success) throw new ProviderHttpError('linear', null, 'bad_response');
    const { viewer } = parsed.data;
    return {
      accountId: viewer.id,
      label: viewer.name ?? viewer.email ?? 'Linear',
      config: {},
      topicSlug: 'personal',
    };
  },
};

export const LINEAR_OAUTH = new OAuthAuth<LinearSecret>(linearApp);

const linearKey: ApiKeyAuthOptions<LinearSecret> = {
  methods: ['personal_api_key'],
  // The personal API key as it is.
  headers: (secret) => ({ authorization: secret.apiKey ?? '' }),
  credential: {
    schema: z.strictObject({ apiKey: Token }),
    fake: (name) => ({ apiKey: `lin_api_${FAKE_MARK}${filler(name, 'key', 36, ALNUM)}` }),
  },
};

export const LINEAR_API_KEY = new ApiKeyAuth<LinearSecret>(linearKey);

const linear: DefinitionSpec<
  LinearSecret,
  { oauth: OAuthAuth<LinearSecret>; apiKey: ApiKeyAuth<LinearSecret> }
> = {
  provider: 'linear',
  auth: { oauth: LINEAR_OAUTH, apiKey: LINEAR_API_KEY },
  config: () => z.strictObject({}),
  connection: { topic: () => 'personal', accountId: () => null, label: () => null },
  adapter: linearAdapter,
  create: {
    steps: ['linearTeam', 'linearProject', 'state'],
    authKinds: ['oauth', 'api_key'],
    linkAllowed: (host) => host === 'linear.app' || host.endsWith('.linear.app'),
    forbiddenWithOAuth: 'rejected',
    readOptions: linearOptions,
  },
  revokePage: 'https://linear.app/settings/account/security',
  fixtures: { createOptions: 'create-options' },
};

export const LINEAR = new IntegrationDefinition(linear);
