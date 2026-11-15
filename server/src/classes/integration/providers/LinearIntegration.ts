import type { Caller } from '../../base/Caller.js';
import { AppError } from '../../../errors/AppError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import { readBackLinear } from '../../../services/providerCreate/created.js';
import { createReadOnlyClient, type ReadOnlyClient, type Transport } from '../../../sync/http.js';
import { LINEAR_DOCUMENTS, LINEAR_ENDPOINT } from '../../../sync/providers/linear.js';
import type { EmptyConfig } from '../../../types/integrations.js';
import type { CreateTarget } from '../../../types/providerCreate.js';
import type { ApiKeyAuth } from '../auth/ApiKeyAuth.js';
import type { OAuthAuth } from '../auth/OAuthAuth.js';
import type { Revocable, SupportsApiKey, SupportsOAuth } from '../capabilities.js';
import { LINEAR, type LinearSecret } from '../definitions/linear.js';
import { IntegrationRegistry } from '../IntegrationRegistry.js';
import {
  TrackerIntegration,
  type PreparedCreate,
  type TrackerWriteSession,
} from '../TrackerIntegration.js';
import { linearIssueInput, type CreateFields } from '../writers/trackerWriter.js';

export type { LinearSecret };

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

/**
 * Linear: issues read through its GraphQL API (allow-listed documents only), an issue created in
 * a team (and project, state). Its OAuth grant is revoked at Linear when it is disconnected.
 */
export class LinearIntegration
  extends TrackerIntegration<EmptyConfig, LinearSecret>
  implements Revocable, SupportsOAuth<LinearSecret>, SupportsApiKey<LinearSecret>
{
  /** What Linear is: its strategies, config, rules, adapter, funnel and fixtures. */
  static readonly definition = LINEAR;

  static {
    IntegrationRegistry.instance.register(LinearIntegration, (data) => new LinearIntegration(data));
  }

  private constructor(data: IntegrationData) {
    super(data);
  }

  get oauth(): OAuthAuth<LinearSecret> {
    return LinearIntegration.definition.auth.oauth;
  }

  get apiKey(): ApiKeyAuth<LinearSecret> {
    return LinearIntegration.definition.auth.apiKey;
  }

  /** Its owner hands the OAuth grant back to Linear (revokeGrant). */
  async revoke(caller: Caller): Promise<void> {
    this.assertOwner(caller);
    await this.revokeGrant();
  }

  /**
   * Disconnect: the OAuth grant goes back to Linear (its revocation endpoint). Best effort: never
   * throws. Left in place when another live integration (any workspace) uses the same account,
   * whose grant revoking would end too.
   */
  protected override revokeGrant(): Promise<void> {
    return this.handBackGrant('An OAuth grant could not be revoked');
  }

  /** The read client with the funnel's and the read-back's GraphQL documents. */
  protected override readClient(transport: Transport): ReadOnlyClient {
    return createReadOnlyClient({
      provider: this.provider,
      transport,
      maxRetries: 1,
      graphql: {
        endpoint: LINEAR_ENDPOINT,
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
