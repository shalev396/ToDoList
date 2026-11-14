/**
 * "One row, not three" (H5): right after a create, the created item is fetched back through the
 * read client (GET by id), mapped by the provider's own sync mapper and stored through the same
 * upsert the sync uses (bulkUpsert by natural key, with the same record checks and source hash),
 * so it exists at once. It is then marked `overlay.copyOf = <local to-do>`: the access filter hides
 * it from whoever sees the to-do (copyAbsorptionFilter), and the to-do's row shows a chip for it.
 *
 * The stored copy carries the sync resource of its provider, so a later full sync keeps it only
 * when the integration's scope includes it (an issue not assigned to the user is swept), and
 * takes it over, overlay untouched, when it does.
 */
import type { ContainerData } from '../../models/definitions/Container.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { ItemData, ItemUpsert } from '../../models/definitions/Item.js';
import { getContainerRepository, getItemRepository } from '../../models/index.js';
import { itemSourceHash } from '../../sync/hash.js';
import { itemProblem } from '../../sync/recordCheck.js';
import type { MappedItem } from '../../sync/types.js';
import { defaultTopicForIntegration } from '../topicRules.js';

const RESOURCES: Readonly<Record<string, string>> = {
  jira: 'issues',
  linear: 'issues',
  github: 'issues',
  clickup: 'tasks',
};

function syncResourceOf(integration: IntegrationData, mapped: MappedItem): string | null {
  if (integration.provider === 'google_calendar') {
    return mapped.containerExternalId === undefined || mapped.containerExternalId === null
      ? null
      : `calendar:${mapped.containerExternalId}`;
  }
  return RESOURCES[integration.provider] ?? null;
}

/** Stores the mapped item (null when it fails the record checks) and returns the stored row. */
export async function storeMirroredItem(
  integration: IntegrationData,
  mapped: MappedItem,
): Promise<ItemData | null> {
  if (itemProblem(mapped) !== null || mapped.source.externalId === '' || mapped.source.url === '') {
    return null;
  }
  const { workspaceId } = integration;
  let container: ContainerData | null = null;
  if (mapped.containerExternalId !== undefined && mapped.containerExternalId !== null) {
    [container = null] = await (
      await getContainerRepository()
    ).list(workspaceId, {
      integrationId: integration.id,
      externalIds: [mapped.containerExternalId],
    });
  }
  const upsert: ItemUpsert = {
    integrationId: integration.id,
    containerId: container?.id ?? null,
    kind: mapped.kind,
    topicId:
      mapped.topicId !== undefined
        ? mapped.topicId
        : container !== null
          ? container.topicId
          : defaultTopicForIntegration(integration),
    title: mapped.title,
    bodyPreview: mapped.bodyPreview ?? null,
    status: mapped.status,
    statusRaw: mapped.statusRaw ?? null,
    priority: mapped.priority ?? null,
    startAt: mapped.startAt ?? null,
    dueAt: mapped.dueAt ?? null,
    endAt: mapped.endAt ?? null,
    allDay: mapped.allDay ?? false,
    assignees: mapped.assignees ?? [],
    labels: mapped.labels ?? [],
    props: mapped.props ?? {},
    closedAt: mapped.closedAt ?? null,
    deletedAt: null,
    source: {
      ...mapped.source,
      provider: integration.provider,
      accountId: integration.accountId,
    },
    // The resource a sync lists it under: a later full sync keeps it only if its scope includes
    // it, like every item of the integration (the copy is never kept by us alone).
    syncResource: syncResourceOf(integration, mapped),
  };
  const withHash: ItemUpsert = {
    ...upsert,
    source: { ...upsert.source, hash: itemSourceHash(upsert) },
  };
  const items = await getItemRepository();
  await items.bulkUpsert(workspaceId, [withHash]);
  return items.findBySource(
    workspaceId,
    {
      provider: integration.provider,
      accountId: integration.accountId,
      integrationId: integration.id,
    },
    mapped.source.externalId,
  );
}

/** Marks the stored provider item as the copy of a local to-do. */
export async function markAsCopy(
  workspaceId: string,
  mirroredId: string,
  todo: Pick<ItemData, 'id' | 'ownerUserId' | 'visibility'>,
): Promise<void> {
  await (
    await getItemRepository()
  ).setOverlay(workspaceId, mirroredId, {
    copyOf: todo.id,
    copyOfOwner: todo.ownerUserId,
    copyOfShared: todo.visibility === 'workspace',
  });
}
