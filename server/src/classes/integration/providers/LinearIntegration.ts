import type { Caller } from '../../base/Caller.js';
import { AppError } from '../../../errors/AppError.js';
import { StatusNotAvailableError } from '../../../errors/StatusNotAvailableError.js';
import { ValidationError } from '../../../errors/ValidationError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import type { ItemData, MirroredItemPatch } from '../../../models/definitions/Item.js';
import { readBackLinear } from '../../../services/providerCreate/created.js';
import { checkedId } from '../providerIds.js';
import { createReadOnlyClient, type ReadOnlyClient, type Transport } from '../../../sync/http.js';
import { LINEAR_DOCUMENTS, LINEAR_ENDPOINT, linearStatus } from '../../../sync/providers/linear.js';
import {
  asObject,
  asString,
  dateOnlyDueAt,
  localDateString,
} from '../../../sync/providers/trackerCommon.js';
import type { ItemStatus } from '../../../types/domain.js';
import type { EmptyConfig, WritableField } from '../../../types/integrations.js';
import type { CreateTarget } from '../../../types/providerCreate.js';
import type { ApiKeyAuth } from '../auth/ApiKeyAuth.js';
import type { OAuthAuth } from '../auth/OAuthAuth.js';
import type { Revocable, SupportsApiKey, SupportsOAuth } from '../capabilities.js';
import { LINEAR, type LinearSecret } from '../definitions/linear.js';
import { IntegrationRegistry } from '../IntegrationRegistry.js';
import {
  TrackerIntegration,
  type PreparedCreate,
  type ProviderPatch,
  type TrackerWriteSession,
  type WriteLedger,
} from '../TrackerIntegration.js';
import {
  linearIssueInput,
  linearUpdateInput,
  type CreateFields,
} from '../writers/trackerWriter.js';

export type { LinearSecret };

/**
 * The read documents of a create and a write-back: the funnel's, the one that fetches a created
 * issue, and the one that lists an issue's team's workflow states. All queries (the read client
 * refuses a mutation when it is built).
 */
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
  IssueTeamStates: `query IssueTeamStates($id: String!) {
  issue(id: $id) { team { states(first: 100) { nodes { id name type position } } } }
}`,
};

/**
 * The workflow state types a write-back may pick from, in order, for each status (the sync reads
 * backlog, unstarted and triage as open; started as in progress; completed; canceled).
 */
const STATE_TYPES_OF: Readonly<Record<ItemStatus, readonly string[]>> = {
  open: ['unstarted', 'backlog', 'triage'],
  in_progress: ['started'],
  done: ['completed'],
  cancelled: ['canceled'],
};

/** One workflow state of a team. */
interface LinearState {
  id: string;
  name: string | null;
  type: string;
  position: number;
}

function stateOf(raw: unknown): LinearState[] {
  const state = asObject(raw);
  const id = asString(state?.['id']);
  const type = asString(state?.['type']);
  if (id === null || type === null || !/^[0-9a-fA-F-]{36}$/.test(id)) return [];
  const position = Number(state?.['position']);
  return [
    {
      id,
      name: asString(state?.['name']),
      type,
      position: Number.isFinite(position) ? position : Number.MAX_SAFE_INTEGER,
    },
  ];
}

interface IssueTeamStates {
  issue?: { team?: { states?: { nodes?: unknown } } } | null;
}

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

  /** Linear's own rule besides the reachable statuses: its 0 is "none", so no lowest (0). */
  protected override checkUpdate(item: ItemData, patch: ProviderPatch): void {
    super.checkUpdate(item, patch);
    if (patch.priority === 0) {
      throw new ValidationError('priority: Linear has no lowest priority (0), only none');
    }
  }

  /**
   * A Linear issue's write-back: the asked status is looked up first among its team's workflow
   * states (the `IssueTeamStates` query: the first of the matching type, by position; none:
   * StatusNotAvailableError), then the `issueUpdate` mutation is sent (title, state, due date,
   * priority) and confirmed to the ledger. Linear answers with the issue: its title and state are
   * what it confirms.
   */
  protected async applyUpdate(
    session: TrackerWriteSession,
    item: ItemData,
    patch: ProviderPatch,
    ledger: WriteLedger,
  ): Promise<void> {
    const issueId = checkedId('linearId', item.source.externalId, 'item');
    const state =
      patch.status === undefined ? undefined : await this.#stateFor(session, issueId, patch.status);
    const input = linearUpdateInput(patch, state?.id);
    const record = this.answerOf(
      await session.write.updateLinearIssue(session.headers, issueId, input),
    );
    const confirmed: MirroredItemPatch = {};
    const fields: WritableField[] = [];
    if (patch.title !== undefined) {
      confirmed.title = asString(record?.['title']) ?? patch.title;
      fields.push('title');
    }
    if (patch.status !== undefined && state !== undefined) {
      const answered = asObject(record?.['state']);
      Object.assign(
        confirmed,
        this.confirmedStatus(
          linearStatus(answered?.['type']) ?? patch.status,
          asString(answered?.['name']) ?? state.name,
        ),
      );
      fields.push('status');
    }
    if (patch.due !== undefined) {
      const due =
        patch.due === null
          ? null
          : dateOnlyDueAt(localDateString(patch.due.at, patch.timeZone), patch.timeZone);
      confirmed.dueAt = due;
      confirmed.allDay = due !== null;
      fields.push('dueAt');
    }
    if (patch.priority !== undefined) {
      confirmed.priority = patch.priority;
      fields.push('priority');
    }
    await ledger.confirm(fields, confirmed);
  }

  /** The workflow state of the issue's team that `status` becomes (StatusNotAvailableError: none). */
  async #stateFor(
    session: TrackerWriteSession,
    issueId: string,
    status: ItemStatus,
  ): Promise<LinearState> {
    const data = await session.read.graphql<IssueTeamStates>(
      'IssueTeamStates',
      { id: issueId },
      session.headers,
    );
    const nodes = data.issue?.team?.states?.nodes;
    const states = (Array.isArray(nodes) ? (nodes as unknown[]) : [])
      .flatMap(stateOf)
      .sort((a, b) => a.position - b.position);
    for (const type of STATE_TYPES_OF[status]) {
      const chosen = states.find((entry) => entry.type === type);
      if (chosen !== undefined) return chosen;
    }
    throw new StatusNotAvailableError('linear', status);
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
