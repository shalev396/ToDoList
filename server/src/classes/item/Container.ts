/**
 * A container (DATA.md §3.7): a project, list, repo, course, folder or calendar an integration
 * syncs, which its items sit in. The only code that reads containers outside the sync engine.
 * What a caller may see of them follows ItemPolicy (their own integrations' and the shared ones').
 */
import type { Caller } from '../base/Caller.js';
import type { Auditable, SoftDeletable, Viewable } from '../base/contracts.js';
import { AuditTarget } from '../base/AuditTarget.js';
import { WorkspaceEntity } from '../base/WorkspaceEntity.js';
import type { ItemPolicy } from '../policies/ItemPolicy.js';
import { AppError } from '../../errors/AppError.js';
import type { ContainerData } from '../../models/definitions/Container.js';
import { getContainerRepository } from '../../models/index.js';
import { redactString } from '../../services/secretPatterns.js';
import type { ContainerType, Provider } from '../../types/domain.js';
import type { FacetContainer } from '../../types/items.js';

/** The facet list's cap (by name). */
export const FACET_CONTAINER_CAP = 500;

type Doc = Readonly<Record<string, unknown>>;

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A container as its integration's facet or link needs it, from a stored row. */
function dataOf(doc: Doc): ContainerData {
  const source = (
    typeof doc['source'] === 'object' && doc['source'] !== null ? doc['source'] : {}
  ) as Doc;
  const date = (value: unknown): Date | null => (value instanceof Date ? value : null);
  return {
    id: String(doc['_id'] ?? doc['id']),
    workspaceId: text(doc['workspaceId']) ?? '',
    integrationId: text(doc['integrationId']) ?? '',
    topicId: text(doc['topicId']),
    type: doc['type'] as ContainerType,
    name: text(doc['name']) ?? '',
    parentId: text(doc['parentId']),
    path: Array.isArray(doc['path'])
      ? (doc['path'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [],
    source: {
      provider: source['provider'] as Provider,
      accountId: text(source['accountId']) ?? '',
      externalId: text(source['externalId']) ?? '',
      key: text(source['key']),
      url: text(source['url']) ?? '',
      updatedAtSource: date(source['updatedAtSource']),
      etag: text(source['etag']),
      hash: text(source['hash']),
    },
    syncResource: text(doc['syncResource']),
    props: {},
    hidden: doc['hidden'] === true,
    deletedAt: date(doc['deletedAt']),
    lastSeenAt: date(doc['lastSeenAt']),
    createdAt: date(doc['createdAt']) ?? new Date(0),
    updatedAt: date(doc['updatedAt']) ?? new Date(0),
  };
}

export class Container
  extends WorkspaceEntity<ContainerData>
  implements Auditable, SoftDeletable, Viewable<FacetContainer>
{
  private constructor(data: ContainerData) {
    super(data);
  }

  static from(data: ContainerData): Container {
    return new Container(data);
  }

  /**
   * The container `id` when the caller may see it (its integration is theirs or shared); a
   * to-do placed in anything else is refused (400: the same answer as an id that never existed).
   */
  static async assertVisible(caller: Caller, policy: ItemPolicy, id: string): Promise<void> {
    const [found] = await (
      await getContainerRepository()
    ).aggregate(caller.workspaceId, [
      { $match: { ...policy.containerFilter(caller.context), _id: id } },
      { $limit: 1 },
    ]);
    if (found === undefined) throw new AppError(400, 'containerId: unknown container');
  }

  /**
   * The containers the caller may see, by name (at most FACET_CONTAINER_CAP); `integrationIds`
   * narrows them to those integrations' (an empty list: none).
   */
  static async listVisible(
    caller: Caller,
    policy: ItemPolicy,
    integrationIds?: readonly string[],
  ): Promise<Container[]> {
    const docs = await (
      await getContainerRepository()
    ).aggregate(caller.workspaceId, [
      {
        $match: {
          $and: [
            policy.containerFilter(caller.context),
            integrationIds === undefined ? {} : { integrationId: { $in: [...integrationIds] } },
          ],
        },
      },
      { $sort: { name: 1, _id: 1 } },
      { $limit: FACET_CONTAINER_CAP },
    ]);
    return docs.map((doc) => new Container(dataOf(doc)));
  }

  /** The integration's live container with this external id (a created item's), or null. */
  static async findByExternalId(
    workspaceId: string,
    integrationId: string,
    externalId: string,
  ): Promise<Container | null> {
    const [found] = await (
      await getContainerRepository()
    ).list(workspaceId, { integrationId, externalIds: [externalId] });
    return found === undefined ? null : new Container(found);
  }

  /** How many live containers an integration has (the demo data's summary). */
  static async countLiveOf(workspaceId: string, integrationId: string): Promise<number> {
    return (await (await getContainerRepository()).list(workspaceId, { integrationId })).length;
  }

  /** A topic was deleted: its containers become Unsorted (Topic.delete). Returns how many. */
  static async unsetTopicIn(workspaceId: string, topicId: string): Promise<number> {
    return (await getContainerRepository()).unsetTopic(workspaceId, topicId);
  }

  get integrationId(): string {
    return this.data.integrationId;
  }

  get topicId(): string | null {
    return this.data.topicId;
  }

  get deletedAt(): Date | null {
    return this.data.deletedAt;
  }

  get isDeleted(): boolean {
    return this.data.deletedAt !== null;
  }

  auditTarget(): AuditTarget {
    return AuditTarget.of('container', this.id);
  }

  /** As the facets list it (the name redacted). */
  toView(): FacetContainer {
    const { data } = this;
    return {
      id: this.id,
      name: redactString(data.name),
      type: data.type,
      topicId: data.topicId,
      provider: data.source.provider,
      integrationId: data.integrationId,
      externalId: data.source.externalId,
    };
  }
}
