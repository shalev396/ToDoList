import { AppError } from '../../../errors/AppError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import { oauthClient } from '../../../services/oauth/client.js';
import { clickupTeams } from '../../../services/oauth/providers.js';
import { readBackClickup } from '../../../services/providerCreate/created.js';
import { clickupOptions } from '../../../services/providerCreate/funnel.js';
import { checkedId } from '../../../services/providerCreate/ids.js';
import type { ClickUpConfig, OAuthResource } from '../../../types/integrations.js';
import type {
  CreateOptionsQuery,
  CreateOptionsResponseData,
  CreateTarget,
} from '../../../types/providerCreate.js';
import { ApiKeyAuth } from '../auth/ApiKeyAuth.js';
import type { HeaderBuilder } from '../auth/AuthStrategy.js';
import { OAuthAuth } from '../auth/OAuthAuth.js';
import type { SupportsApiKey, SupportsOAuth } from '../capabilities.js';
import { checkGrantSelection } from '../grantSelection.js';
import { IntegrationRegistry } from '../IntegrationRegistry.js';
import {
  TrackerIntegration,
  type PreparedCreate,
  type TrackerReadSession,
  type TrackerWriteSession,
} from '../TrackerIntegration.js';
import { clickupTaskBody, type CreateFields } from '../writers/trackerWriter.js';

/** `{accessToken, …}` (OAuth) or `{token}` (a personal token). */
export type ClickUpSecret = Readonly<{ accessToken?: string; scope?: string; token?: string }>;

/** An OAuth grant's bearer token, or the personal token as it is. */
const clickupHeaders: HeaderBuilder<ClickUpSecret> = (secret) => {
  const accessToken = secret.accessToken;
  return {
    authorization: accessToken === undefined ? (secret.token ?? '') : `Bearer ${accessToken}`,
  };
};

/** ClickUp: the tasks of the chosen workspaces' lists, and a task created in a list. */
export class ClickUpIntegration
  extends TrackerIntegration<ClickUpConfig, ClickUpSecret>
  implements SupportsOAuth<ClickUpSecret>, SupportsApiKey<ClickUpSecret>
{
  static readonly #oauth = new OAuthAuth<ClickUpSecret>({
    provider: 'clickup',
    refresh: 'stored',
    headers: clickupHeaders,
  });
  static readonly #apiKey = new ApiKeyAuth<ClickUpSecret>({
    methods: ['personal_token'],
    headers: clickupHeaders,
  });

  static {
    IntegrationRegistry.instance.register('clickup', (data) => new ClickUpIntegration(data));
  }

  protected readonly createSteps = ['workspace', 'space', 'folder', 'list'] as const;

  private constructor(data: IntegrationData) {
    super(data);
  }

  get oauth(): OAuthAuth<ClickUpSecret> {
    return ClickUpIntegration.#oauth;
  }

  get apiKey(): ApiKeyAuth<ClickUpSecret> {
    return ClickUpIntegration.#apiKey;
  }

  /** The workspaces an OAuth grant can read, live from ClickUp, for the owner to pick from. */
  async grantResources(): Promise<OAuthResource[]> {
    return this.withReadSession(({ secret }) =>
      clickupTeams(oauthClient('clickup'), secret.accessToken ?? ''),
    );
  }

  protected override checkSelection(
    config: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return checkGrantSelection(this.data, config, () => this.grantResources());
  }

  protected readOptions(
    session: TrackerReadSession,
    query: CreateOptionsQuery,
  ): Promise<CreateOptionsResponseData> {
    return clickupOptions(session, query);
  }

  protected prepare(
    session: TrackerWriteSession,
    target: CreateTarget,
    fields: CreateFields,
  ): Promise<PreparedCreate> {
    if (target.provider !== 'clickup') {
      throw new AppError(400, 'target: nothing is created this way');
    }
    const { headers, write } = session;
    const env = { timeZone: fields.timeZone };
    const listId = checkedId('clickupId', target.listId, 'listId');
    const body = clickupTaskBody(fields);
    return Promise.resolve({
      write: () => write.createClickupTask(listId, headers, body),
      readBack: (record) => readBackClickup(session, record, env),
    });
  }
}
