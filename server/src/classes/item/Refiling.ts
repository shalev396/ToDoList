/**
 * File under, applied to what is already stored: containers and items move to the topic the
 * workspace's rules give them, in place. The same rule the sync applies (`toContainerUpsert`,
 * `toItemUpsert` in classes/sync/syncRecords.ts), with no provider call and no quota: a sync is
 * incremental, so it would leave unchanged records where they were.
 *
 * A container's topic is the first matching rule for its match key, else its integration's topic;
 * an item follows its container, and a container-less item the integration's topic. Only
 * `topicId` is written: an item's overlay (`topicOverride`) is the user's and stays.
 */
import type { Integration } from '../integration/Integration.js';
import { TopicRules } from '../workspace/TopicRules.js';
import {
  getContainerRepository,
  getItemRepository,
  getWorkspaceRepository,
} from '../../models/index.js';
import type { RefileCounts } from '../../types/topicRules.js';
import { Container } from './Container.js';

export type { RefileCounts };

export class Refiling {
  readonly #rules: TopicRules;

  private constructor(rules: TopicRules) {
    this.#rules = rules;
  }

  /** The workspace's rules as they are now. */
  static async #ofWorkspace(workspaceId: string): Promise<Refiling> {
    const workspace = await (await getWorkspaceRepository()).findById(workspaceId);
    return new Refiling(TopicRules.of(workspace?.settings.topicRules));
  }

  /**
   * One integration's live containers re-classified by the workspace's current rules (default:
   * its topic), then its items follow their container (container-less: the integration's topic).
   * Never writes an overlay.
   */
  static async integration(integration: Integration): Promise<RefileCounts> {
    return (await Refiling.#ofWorkspace(integration.workspaceId)).#refile(integration);
  }

  /** Every live integration of the workspace (a rule change). */
  static async workspace(workspaceId: string): Promise<RefileCounts> {
    // Lazy: Integration reaches this class too.
    const { Integration: Integrations } = await import('../integration/Integration.js');
    const refiling = await Refiling.#ofWorkspace(workspaceId);
    const total: RefileCounts = { containers: 0, items: 0 };
    for (const integration of await Integrations.listIn(workspaceId)) {
      const counts = await refiling.#refile(integration);
      total.containers += counts.containers;
      total.items += counts.items;
    }
    return total;
  }

  async #refile(integration: Integration): Promise<RefileCounts> {
    const { workspaceId } = integration;
    const defaultTopicId = TopicRules.defaultFor({ topicId: integration.topicId });
    const containers = await Container.listOf(workspaceId, integration.id);
    const assignments = containers.map((container) => ({
      container,
      topicId: this.#rules.classify({ matchKey: container.matchKey, defaultTopicId }),
    }));
    const changed = assignments
      .filter(({ container, topicId }) => container.topicId !== topicId)
      .map(({ container, topicId }) => ({ id: container.id, topicId }));
    const moved = await (await getContainerRepository()).setTopics(workspaceId, changed);
    const items = await (
      await getItemRepository()
    ).refileByContainer(workspaceId, integration.id, [
      ...assignments.map(({ container, topicId }) => ({ containerId: container.id, topicId })),
      { containerId: null, topicId: defaultTopicId },
    ]);
    return { containers: moved, items };
  }
}
