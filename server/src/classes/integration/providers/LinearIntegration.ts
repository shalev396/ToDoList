import { AppError } from '../../../errors/AppError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import { logger } from '../../../services/logger.js';
import { oauthClient } from '../../../services/oauth/client.js';
import { readBackLinear } from '../../../services/providerCreate/created.js';
import { linearOptions } from '../../../services/providerCreate/funnel.js';
import { createReadOnlyClient, type ReadOnlyClient, type Transport } from '../../../sync/http.js';
import { LINEAR_DOCUMENTS } from '../../../sync/providers/linear.js';
import { oauthEndpoints } from '../../../sync/providers/oauthEndpoints.js';
import type { EmptyConfig } from '../../../types/integrations.js';
import type {
  CreateOptionsQuery,
  CreateOptionsResponseData,
  CreateTarget,
} from '../../../types/providerCreate.js';
import { ApiKeyAuth } from '../auth/ApiKeyAuth.js';
import type { HeaderBuilder } from '../auth/AuthStrategy.js';
import { OAuthAuth } from '../auth/OAuthAuth.js';
import type { Revocable, SupportsApiKey, SupportsOAuth } from '../capabilities.js';
import { IntegrationRegistry } from '../IntegrationRegistry.js';
import {
  TrackerIntegration,
  type PreparedCreate,
  type TrackerReadSession,
  type TrackerWriteSession,
} from '../TrackerIntegration.js';
import { linearIssueInput, type CreateFields } from '../writers/trackerWriter.js';

/** `{accessToken, refreshToken, …}` (OAuth) or `{apiKey}` (a personal API key). */
export type LinearSecret = Readonly<{
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  scope?: string;
  apiKey?: string;
}>;

/** The funnel's Linear read documents, and the one that fetches a created issue. All queries. */
export const LINEAR_CREATE_DOCUMENTS: Readonly<Record<string, string>> = {
  ...LINEAR_DOCUMENTS,
  CreateTeams: 'query CreateTeams { teams(first: 100) { nodes { id key name } } }',
  CreateProjects: `query CreateProjects($id: String!) {
  team(id: $id) { projects(first: 100) { nodes { id name } } }
}`,
  CreateStates: `query CreateStates($id: String!) {
  team(id: $id) { defaultIssueState { id } states(first: 100) { nodes { id name type position } } }
}`,
  CreatedIssue: `query CreatedIssue($id: String!) {
  issue(id: $id) {
    id identifier title description url priority dueDate estimate
    createdAt updatedAt completedAt canceledAt
    state { name type }
    team { id key name }
    project { id name }
    cycle { number name }
    assignee { id name displayName }
    labels { nodes { name } }
  }
}`,
};

/** An OAuth grant's bearer token, or the personal API key as it is. */
const linearHeaders: HeaderBuilder<LinearSecret> = (secret) => {
  const accessToken = secret.accessToken;
  return {
    authorization: accessToken === undefined ? (secret.apiKey ?? '') : `Bearer ${accessToken}`,
  };
};

/**
 * Linear: issues read through its GraphQL API (allow-listed documents only), an issue created in
 * a team (and project, state). Its OAuth grant is revoked at Linear when it is disconnected.
 */
export class LinearIntegration
  extends TrackerIntegration<EmptyConfig, LinearSecret>
  implements Revocable, SupportsOAuth<LinearSecret>, SupportsApiKey<LinearSecret>
{
  static readonly #oauth = new OAuthAuth<LinearSecret>({
    provider: 'linear',
    refresh: 'stored',
    headers: linearHeaders,
  });
  static readonly #apiKey = new ApiKeyAuth<LinearSecret>({
    methods: ['personal_api_key'],
    headers: linearHeaders,
  });

  static {
    IntegrationRegistry.instance.register('linear', (data) => new LinearIntegration(data));
  }

  protected readonly createSteps = ['linearTeam', 'linearProject', 'state'] as const;

  private constructor(data: IntegrationData) {
    super(data);
  }

  get oauth(): OAuthAuth<LinearSecret> {
    return LinearIntegration.#oauth;
  }

  get apiKey(): ApiKeyAuth<LinearSecret> {
    return LinearIntegration.#apiKey;
  }

  /**
   * Disconnect: the OAuth grant goes back to Linear (its revocation endpoint). Best effort: never
   * throws. Left in place when another live integration (any workspace) uses the same account,
   * whose grant revoking would end too.
   */
  async revoke(): Promise<void> {
    if (oauthEndpoints('linear').revoke === null) return;
    try {
      if (await this.sharesGrant()) return;
      await this.withReadSession(async ({ secret }) => {
        await oauthClient('linear').revokeToken(secret.refreshToken ?? secret.accessToken ?? '');
      });
    } catch (error) {
      logger.warn('An OAuth grant could not be revoked', {
        integrationId: this.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  protected readOptions(
    session: TrackerReadSession,
    query: CreateOptionsQuery,
  ): Promise<CreateOptionsResponseData> {
    return linearOptions(session, query);
  }

  /** The read client with the funnel's and the read-back's GraphQL documents. */
  protected override readClient(transport: Transport): ReadOnlyClient {
    return createReadOnlyClient({
      provider: this.provider,
      transport,
      maxRetries: 1,
      graphql: {
        endpoint: 'https://api.linear.app/graphql',
        documents: { ...LINEAR_CREATE_DOCUMENTS },
      },
    });
  }

  protected prepare(
    session: TrackerWriteSession,
    target: CreateTarget,
    fields: CreateFields,
  ): Promise<PreparedCreate> {
    if (target.provider !== 'linear') {
      throw new AppError(400, 'target: nothing is created this way');
    }
    const { headers, write } = session;
    const env = { timeZone: fields.timeZone };
    const input = linearIssueInput(fields, target);
    return Promise.resolve({
      write: () => write.createLinearIssue(headers, input),
      readBack: (record) => readBackLinear(session, record, env),
    });
  }
}
