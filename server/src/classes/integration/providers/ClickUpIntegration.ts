import { AppError } from '../../../errors/AppError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import { readBackClickup } from '../../../services/providerCreate/created.js';
import { checkedId } from '../../../services/providerCreate/ids.js';
import type { ClickUpConfig, OAuthResource } from '../../../types/integrations.js';
import type { CreateTarget } from '../../../types/providerCreate.js';
import type { ApiKeyAuth } from '../auth/ApiKeyAuth.js';
import type { OAuthAuth } from '../auth/OAuthAuth.js';
import type { Caller } from '../../base/Caller.js';
import type { ResourcePicker, SupportsApiKey, SupportsOAuth } from '../capabilities.js';
import { CLICKUP, clickupTeams, type ClickUpSecret } from '../definitions/clickup.js';
import { grantResourcesFor } from '../grantSelection.js';
import type { Integration } from '../Integration.js';
import { IntegrationRegistry } from '../IntegrationRegistry.js';
import {
  TrackerIntegration,
  type PreparedCreate,
  type TrackerWriteSession,
} from '../TrackerIntegration.js';
import { clickupTaskBody, type CreateFields } from '../writers/trackerWriter.js';

export type { ClickUpSecret };

/** ClickUp: the tasks of the chosen workspaces' lists, and a task created in a list. */
export class ClickUpIntegration
  extends TrackerIntegration<ClickUpConfig, ClickUpSecret>
  implements
    SupportsOAuth<ClickUpSecret>,
    SupportsApiKey<ClickUpSecret>,
    ResourcePicker<'workspaces'>
{
  /** What ClickUp is: its strategies, config, rules, adapter, funnel and fixtures. */
  static readonly definition = CLICKUP;

  static {
    IntegrationRegistry.instance.register(
      ClickUpIntegration,
      (data) => new ClickUpIntegration(data),
    );
  }

  private constructor(data: IntegrationData) {
    super(data);
  }

  get oauth(): OAuthAuth<ClickUpSecret> {
    return ClickUpIntegration.definition.auth.oauth;
  }

  get apiKey(): ApiKeyAuth<ClickUpSecret> {
    return ClickUpIntegration.definition.auth.apiKey;
  }

  /** An OAuth grant reaches workspaces to pick from; a personal token reads what it reads. */
  get pickerKind(): 'workspaces' | null {
    return this.authKind === 'oauth' ? 'workspaces' : null;
  }

  /** Its owner: the workspaces the OAuth grant can read, live from ClickUp. */
  async pickerResources(caller: Caller): Promise<OAuthResource[]> {
    this.assertPicks(caller, this.pickerKind);
    return this.#grantTeams();
  }

  /** Its owner reads exactly these workspaces (each one the grant covers). */
  async choose(caller: Caller, ids: readonly string[]): Promise<Integration> {
    this.assertPicks(caller, this.pickerKind);
    return this.update(caller, { config: { ...this.config, teamIds: [...ids] } });
  }

  /** The chosen `teamIds` of an OAuth connection, each one the grant covers (400 otherwise). */
  protected override async checkSelection(
    config: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const chosen = config['teamIds'];
    if (this.authKind !== 'oauth' || chosen === undefined) return config;
    const grant = await grantResourcesFor(this, () => this.#grantTeams());
    const known = new Set(grant.map((resource) => resource.id));
    if ((chosen as string[]).some((id) => !known.has(id))) {
      throw new AppError(400, 'config.teamIds: not a workspace of this connection');
    }
    return config;
  }

  /** The workspaces the OAuth grant reaches, in a read session. */
  async #grantTeams(): Promise<OAuthResource[]> {
    return this.withReadSession(({ secret }) =>
      clickupTeams(this.oauth.client(), this.oauth.headers(secret)),
    );
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
