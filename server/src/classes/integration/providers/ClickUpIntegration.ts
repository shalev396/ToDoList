import { AppError } from '../../../errors/AppError.js';
import { StatusNotAvailableError } from '../../../errors/StatusNotAvailableError.js';
import { ValidationError } from '../../../errors/ValidationError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import type { ItemData, MirroredItemPatch } from '../../../models/definitions/Item.js';
import { readBackClickup } from '../../../services/providerCreate/created.js';
import { checkedId } from '../../../services/providerCreate/ids.js';
import { clickupStatus } from '../../../sync/providers/clickup.js';
import {
  asObject,
  asString,
  dateOnlyDueAt,
  localDateString,
} from '../../../sync/providers/trackerCommon.js';
import type { ItemStatus } from '../../../types/domain.js';
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
  type ProviderPatch,
  type TrackerWriteSession,
} from '../TrackerIntegration.js';
import { clickupTaskBody, clickupUpdateBody, type CreateFields } from '../writers/trackerWriter.js';

export type { ClickUpSecret };

/**
 * The status types a write-back may pick from, in order, for each status (the sync reads `open`
 * as open, `custom` as in progress, `closed` and `done` as done). ClickUp has no "cancelled".
 */
const TYPES_OF: Readonly<Record<ItemStatus, readonly string[]>> = {
  open: ['open'],
  in_progress: ['custom'],
  done: ['closed', 'done'],
  cancelled: [],
};

/** One status of a ClickUp list: its name, type and place. */
interface ListStatus {
  name: string;
  type: string;
  order: number;
}

function listStatusOf(raw: unknown): ListStatus[] {
  const status = asObject(raw);
  const name = asString(status?.['status']);
  const type = asString(status?.['type']);
  if (name === null || type === null) return [];
  const order = Number(status?.['orderindex']);
  return [{ name, type, order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER }];
}

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

  /**
   * A ClickUp task's write-back: the asked status is looked up first among its list's statuses
   * (GET /list/{id}: the first of the matching type, in the list's order; none:
   * StatusNotAvailableError), then the task is PUT (name, status by name, due and start dates,
   * priority). ClickUp answers with the task: its name and status are what it confirms.
   */
  protected async applyUpdate(
    session: TrackerWriteSession,
    item: ItemData,
    patch: ProviderPatch,
  ): Promise<MirroredItemPatch> {
    const taskId = checkedId('clickupTask', item.source.externalId, 'item');
    if (patch.priority === 0) {
      throw new ValidationError('priority: ClickUp has no lowest priority (0), only none');
    }
    const status =
      patch.status === undefined ? undefined : await this.#statusIn(session, item, patch.status);
    const body = clickupUpdateBody(patch, status?.name);
    const record = this.answerOf(
      await session.write.updateClickupTask(taskId, session.headers, body),
    );
    const confirmed: MirroredItemPatch = {};
    if (patch.title !== undefined) confirmed.title = asString(record?.['name']) ?? patch.title;
    if (patch.status !== undefined && status !== undefined) {
      const answered = asObject(record?.['status']);
      Object.assign(
        confirmed,
        this.confirmedStatus(
          clickupStatus(answered?.['type']) ?? patch.status,
          asString(answered?.['status']) ?? status.name,
        ),
      );
    }
    if (patch.due !== undefined) {
      // A due date without a time of day is that day, at its end (as the sync reads it).
      confirmed.dueAt =
        patch.due === null
          ? null
          : patch.due.allDay
            ? dateOnlyDueAt(localDateString(patch.due.at, patch.timeZone), patch.timeZone)
            : patch.due.at;
      if (patch.due !== null) confirmed.allDay = patch.due.allDay;
    }
    if (patch.startAt !== undefined) confirmed.startAt = patch.startAt;
    if (patch.priority !== undefined) confirmed.priority = patch.priority;
    return confirmed;
  }

  /** The status of the task's list that `status` becomes (StatusNotAvailableError: none). */
  async #statusIn(
    session: TrackerWriteSession,
    item: ItemData,
    status: ItemStatus,
  ): Promise<ListStatus> {
    const types = TYPES_OF[status];
    if (types.length === 0) throw new StatusNotAvailableError('clickup', status);
    const listId = checkedId('clickupId', item.props['listId'], 'item');
    const { data } = await session.read.getJson<{ statuses?: unknown }>(
      `https://api.clickup.com/api/v2/list/${listId}`,
      session.headers,
    );
    const statuses = (Array.isArray(data.statuses) ? (data.statuses as unknown[]) : [])
      .flatMap(listStatusOf)
      .sort((a, b) => a.order - b.order);
    for (const type of types) {
      const chosen = statuses.find((entry) => entry.type === type);
      if (chosen !== undefined) return chosen;
    }
    throw new StatusNotAvailableError('clickup', status);
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
