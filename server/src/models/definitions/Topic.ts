import type { TopicColour, TopicIcon } from '../../types/topics.js';

/**
 * A topic: one page of a workspace (PERMISSIONS-V2 "Dynamic topics"). Items, containers,
 * integrations, topic rules and topic dashboards point at it by `id`; its `slug` is its URL.
 */
export interface TopicData {
  id: string;
  workspaceId: string;
  /** Free text, trimmed. */
  name: string;
  /** Standardized (types/topics.ts), unique in the workspace. */
  slug: string;
  icon: TopicIcon | null;
  colour: TopicColour | null;
  /** Sidebar position, smallest first. */
  order: number;
  /** null for the defaults a migration or a workspace creation made. */
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTopicInput {
  /** A stable id (the default topics' ids are derived); a fresh UUID when absent. */
  id?: string;
  name: string;
  slug: string;
  icon?: TopicIcon | null;
  colour?: TopicColour | null;
  order: number;
  createdBy?: string | null;
}

export interface TopicPatch {
  name?: string;
  icon?: TopicIcon | null;
  colour?: TopicColour | null;
  order?: number;
}

export interface ITopicRepository {
  /** Throws a duplicate-key error (code 11000) when the slug or the id is taken. */
  create(workspaceId: string, input: CreateTopicInput): Promise<TopicData>;
  /**
   * create() for each input, in one write, in order, each created a millisecond after the one
   * before it (from `at`, default now). A taken slug or id is skipped: every other input is
   * written, then a duplicate-key error (code 11000) is thrown.
   */
  createMany(
    workspaceId: string,
    inputs: readonly CreateTopicInput[],
    at?: Date,
  ): Promise<TopicData[]>;
  findById(workspaceId: string, id: string): Promise<TopicData | null>;
  findBySlug(workspaceId: string, slug: string): Promise<TopicData | null>;
  /** In sidebar order: `order`, then oldest first. */
  list(workspaceId: string): Promise<TopicData[]>;
  count(workspaceId: string): Promise<number>;
  update(workspaceId: string, id: string, patch: TopicPatch): Promise<TopicData | null>;
  /** Hard delete. False when there was nothing to delete. */
  delete(workspaceId: string, id: string): Promise<boolean>;
  /** Hard-deletes every topic of the workspace (its deletion). Returns how many. */
  deleteForWorkspace(workspaceId: string): Promise<number>;
  /**
   * Global (the purge's sweep): every workspace id a topic names, read from the primary, so a
   * workspace a lagging secondary doesn't show yet is never taken for gone.
   */
  listWorkspaceIds(): Promise<string[]>;
}

export const TOPIC_TABLE_NAME = 'Topics';
