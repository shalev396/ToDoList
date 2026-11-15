/**
 * Moodle (MoodleIntegration's definition): courses, assignments and deadlines, read only, with a
 * web-service token that goes in each call's query string. Coming soon for users; the demo keeps
 * it.
 */
import { z } from 'zod';

import { moodleAdapter } from '../../../sync/providers/moodle.js';
import { ApiKeyAuth, type ApiKeyAuthOptions } from '../auth/ApiKeyAuth.js';
import { FAKE_MARK, filler, HEX } from './fake.js';
import { hostOf, httpsUrl, Token } from './fields.js';
import { IntegrationDefinition, type DefinitionSpec } from './IntegrationDefinition.js';

/** `{token}`: a Moodle web-service token. */
export type MoodleSecret = Readonly<{ token?: string }>;

const token: ApiKeyAuthOptions<MoodleSecret> = {
  methods: ['moodle_ws_token'],
  // No header: the token goes in each web-service call's query (`wstoken`).
  headers: (): Record<string, string> => ({}),
  query: (secret) => ({ wstoken: secret.token ?? '' }),
  credential: {
    schema: z.strictObject({ token: Token }),
    fake: (name) => ({ token: `${FAKE_MARK}${filler(name, 'token', 28, HEX)}` }),
  },
};

export const MOODLE_TOKEN = new ApiKeyAuth<MoodleSecret>(token);

const moodle: DefinitionSpec<MoodleSecret, { apiKey: ApiKeyAuth<MoodleSecret> }> = {
  provider: 'moodle',
  auth: { apiKey: MOODLE_TOKEN },
  config: (allowLocal) => z.strictObject({ siteUrl: httpsUrl(allowLocal) }),
  connection: {
    topic: () => 'college',
    accountId: (config) => hostOf(config['siteUrl']),
    label: (config) => hostOf(config['siteUrl']),
    movedAccount: (integration, config) =>
      hostOf(config['siteUrl']) === integration.accountId ? null : 'siteUrl',
  },
  adapter: moodleAdapter,
  comingSoon: true,
};

export const MOODLE = new IntegrationDefinition(moodle);
