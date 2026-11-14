/**
 * Persona templates (H6, D7): instantiating one makes its topics, pages, views and blocks, and is
 * idempotent per topic slug. A topic that exists is reused (never duplicated); a page that exists
 * keeps what it has; a view is added only when the page lacks one from the same view template.
 * Connectors bind to the instantiating member's own integrations, after the share confirmation
 * (`shareIntegrations: false` binds only those already shared), exactly as the dashboard templates
 * do: the page comes from createDashboard and each view from the add_view op.
 */
import { getPersona, type PersonaFile } from '../builder/personas.js';
import { resolveTemplateKey, type TemplateLanguage } from '../builder/templates.js';
import { resolveViewTemplateKey } from '../builder/viewTemplates.js';
import { WorkspacePolicy } from '../classes/policies/WorkspacePolicy.js';
import { AppError } from '../errors/AppError.js';
import { getDashboardRepository } from '../models/index.js';
import type { IntegrationShare, PersonaInstantiateResult } from '../types/dashboards.js';
import type { WorkspaceContext } from './accessFilter.js';
import {
  applyDashboardOps,
  createDashboard,
  templateShares,
  type BuilderActor,
} from './dashboards.js';
import { createTopic, listTopics, type TopicLanguage } from './topics.js';

export interface InstantiatePersonaInput {
  personaKey: string;
  language: TemplateLanguage;
  shareIntegrations?: boolean | undefined;
}

function persona(key: string): PersonaFile {
  const found = getPersona(key);
  if (found === null) throw new AppError(404, 'No persona template with this key');
  return found;
}

/** What instantiating would do, topic by topic, and what it would share (nothing is written). */
export interface PersonaPlan {
  personaKey: string;
  topics: {
    slug: string;
    name: string;
    /** The topic exists (same slug): it is reused. */
    topicExists: boolean;
    /** The topic has a page: it keeps its blocks. */
    pageExists: boolean;
    /** The view templates that would be added. */
    views: string[];
  }[];
  /** The caller's own integrations that would become shared with the workspace. */
  shares: IntegrationShare[];
}

export async function planPersona(
  ws: WorkspaceContext,
  actor: BuilderActor,
  input: InstantiatePersonaInput,
): Promise<PersonaPlan> {
  WorkspacePolicy.requireRole(ws.role, 'edit', 'add pages');
  const found = persona(input.personaKey);
  const dashboards = await getDashboardRepository();
  const topics = await listTopics(ws);
  const planned: PersonaPlan['topics'] = [];
  for (const topic of found.topics) {
    const existing = topics.find((entry) => entry.slug === topic.slug);
    const [page] =
      existing === undefined
        ? []
        : await dashboards.list(ws.id, { topicId: existing.id, page: 'topic' });
    const have = new Set(
      (page?.views ?? []).flatMap((view) => {
        const key = (view as { templateKey?: unknown }).templateKey;
        return typeof key === 'string' ? [key] : [];
      }),
    );
    planned.push({
      slug: topic.slug,
      name: existing?.name ?? topic.names[input.language],
      topicExists: existing !== undefined,
      pageExists: page !== undefined,
      views: topic.views.flatMap((view) => {
        const key = resolveViewTemplateKey(view);
        return key === null || have.has(key) ? [] : [key];
      }),
    });
  }
  const shares =
    input.shareIntegrations === false ? [] : await templateShares(ws, actor, [found.key]);
  return { personaKey: found.key, topics: planned, shares };
}

/**
 * Makes (or completes) the persona's topics. Safe to repeat: a second run changes nothing. A
 * failure part-way leaves what was made; running it again finishes the rest.
 */
export async function instantiatePersona(
  ws: WorkspaceContext,
  actor: BuilderActor,
  input: InstantiatePersonaInput,
): Promise<PersonaInstantiateResult> {
  WorkspacePolicy.requireRole(ws.role, 'edit', 'add pages');
  const found = persona(input.personaKey);
  const language: TopicLanguage = input.language;
  const dashboards = await getDashboardRepository();
  const result: PersonaInstantiateResult = { personaKey: found.key, topics: [] };

  for (const planned of found.topics) {
    const existing = (await listTopics(ws)).find((topic) => topic.slug === planned.slug);
    const topic =
      existing ??
      (await createTopic(ws, actor, {
        name: planned.names[language],
        icon: planned.icon,
        colour: planned.colour,
        slug: planned.slug,
      }));

    const [page] = await dashboards.list(ws.id, { topicId: topic.id, page: 'topic' });
    const pageCreated = page === undefined;
    let dashboardId: string;
    let version: number;
    if (page === undefined) {
      const templateKey = resolveTemplateKey(planned.page);
      if (templateKey === null) throw new AppError(500, 'A persona names an unknown page template');
      const created = await createDashboard(ws, actor, {
        title: topic.name,
        scope: { topicId: topic.id, containerId: null, page: 'topic', groupVar: null },
        language,
        shareIntegrations: input.shareIntegrations,
        fromTemplate: templateKey,
      });
      dashboardId = created.id;
      version = created.version;
    } else {
      dashboardId = page.id;
      version = page.version;
    }

    const have = new Set(
      (page?.views ?? []).flatMap((view) => {
        const key = (view as { templateKey?: unknown }).templateKey;
        return typeof key === 'string' ? [key] : [];
      }),
    );
    const viewsAdded: string[] = [];
    for (const viewKey of planned.views) {
      const key = resolveViewTemplateKey(viewKey);
      if (key === null || have.has(key)) continue;
      const written = await applyDashboardOps(ws, actor, dashboardId, {
        expectedVersion: version,
        ops: [{ op: 'add_view', templateKey: key }],
        language,
        shareIntegrations: input.shareIntegrations,
      });
      if ('version' in written) version = written.version;
      viewsAdded.push(key);
    }
    result.topics.push({
      id: topic.id,
      slug: topic.slug,
      created: existing === undefined,
      dashboardId,
      pageCreated,
      viewsAdded,
    });
  }
  return result;
}
