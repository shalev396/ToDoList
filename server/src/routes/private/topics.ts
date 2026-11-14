import { Router } from 'express';
import { TopicsController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';
import type { TopicColour, TopicIcon } from '../../types/topics.js';

/**
 * Topics (H2): the pages of a workspace, as data (services/topics.ts). Every member sees them all;
 * editors and owners add, rename, reorder and delete them. Non-members get 404.
 */
const router = Router();

/** One topic: a page of the workspace, at `/t/<slug>`. */
export interface TopicView {
  id: string;
  /** Free text. */
  name: string;
  /** Standardized from the name at creation, unique in the workspace, never changed. */
  slug: string;
  icon: TopicIcon | null;
  colour: TopicColour | null;
  /** Sidebar position, smallest first. */
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── GET /api/private/workspaces/:wid/topics ────────────────────────────────

/** Viewer. In sidebar order. */
export type ListTopicsResponseData = TopicView[];

router.get('/workspaces/:wid/topics', requireWorkspace('viewer'), TopicsController.list);

// ─── POST /api/private/workspaces/:wid/topics ───────────────────────────────

/**
 * Editor. "+ Add page": 201 with the new topic, last in the sidebar, and its first page: empty,
 * or from a topic-page template (`work@1`, `Personal`…; a group page's template is a 400). The
 * slug is standardized from the name and numbered when taken (`work-2`). 409 `topic_limit` at the
 * cap per workspace (50).
 */
export interface CreateTopicRequestBody {
  name: string;
  icon?: TopicIcon | null;
  colour?: TopicColour | null;
  templateKey?: string;
  /** The page title's and the template's language. Default: en. */
  language?: 'en' | 'he';
  /**
   * false: the template binds only the caller's integrations that are already shared, so
   * creating shares nothing new ("Create without them"). Default: true. POST
   * …/builder/template-shares says what true would share.
   */
  shareIntegrations?: boolean;
}

export interface CreateTopicResponseData {
  topic: TopicView;
  /** Its first page. */
  dashboardId: string;
}

router.post('/workspaces/:wid/topics', requireWorkspace('editor'), TopicsController.create);

// ─── PATCH /api/private/workspaces/:wid/topics/:tid ─────────────────────────

/** Editor. Rename, re-icon, recolour or move; at least one change. The slug never changes. */
export interface UpdateTopicRequestBody {
  name?: string;
  icon?: TopicIcon | null;
  colour?: TopicColour | null;
  order?: number;
}

export type UpdateTopicResponseData = TopicView;

router.patch('/workspaces/:wid/topics/:tid', requireWorkspace('editor'), TopicsController.update);

// ─── DELETE /api/private/workspaces/:wid/topics/:tid ────────────────────────

/**
 * Editor. Deletes the topic and its pages only (its topic and group dashboards, with their views,
 * layouts and filters) and the topic rules that file into it. Its items stay, Unsorted (`topicId:
 * null`), local to-dos included. Answers what changed, as counts.
 */
export interface DeleteTopicResponseData {
  dashboards: number;
  items: number;
  containers: number;
  integrations: number;
  rules: number;
}

router.delete('/workspaces/:wid/topics/:tid', requireWorkspace('editor'), TopicsController.remove);

export { router as topicsRouter };
