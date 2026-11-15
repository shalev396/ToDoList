/**
 * Persona templates (H6, D7): a set of topics, each with a page and its views. Instantiating one
 * makes them, and is idempotent per topic slug: a topic that exists is reused (never duplicated);
 * a page that exists keeps what it has; a view is added only when the page lacks one from the same
 * view template. Connectors bind to the instantiating member's own integrations, after the share
 * confirmation (`shareIntegrations: false` binds only those already shared), exactly as the
 * dashboard templates do: the page comes from Dashboard.create and each view from the add_view op.
 */
import { getPersona, type PersonaFile } from '../../builder/personas.js';
import { resolveTemplateKey, type TemplateLanguage } from '../../builder/templates.js';
import { resolveViewTemplateKey } from '../../builder/viewTemplates.js';
import { AppError } from '../../errors/AppError.js';
import type { IntegrationShare, PersonaInstantiateResult } from '../../types/dashboards.js';
import type { Caller } from '../base/Caller.js';
import { Topic, type TopicLanguage } from '../workspace/Topic.js';
import { Dashboard } from './Dashboard.js';
import type { DashboardOutline } from './DashboardOutline.js';
import { Operation } from './Operation.js';

export interface InstantiatePersonaInput {
  personaKey: string;
  language: TemplateLanguage;
  shareIntegrations?: boolean | undefined;
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

/** The view templates a page already has a view from. */
function viewTemplatesOf(page: DashboardOutline | undefined): Set<string> {
  return new Set(page?.viewTemplateKeys ?? []);
}

export class Persona {
  /** Adding a persona's pages is an editor's (WorkspacePolicy: editors change the content). */
  static readonly Operation = Operation.of('editor', 'add pages');

  readonly #file: PersonaFile;

  private constructor(file: PersonaFile) {
    this.#file = file;
    Object.freeze(this);
  }

  /** The persona with this key or name; 404 when there is none. */
  static #of(key: string): Persona {
    const found = getPersona(key);
    if (found === null) throw new AppError(404, 'No persona template with this key');
    return new Persona(found);
  }

  get key(): string {
    return this.#file.key;
  }

  /** The topic's page, as any dashboard of the workspace (a natural-key lookup). */
  static async #pageOf(caller: Caller, topicId: string): Promise<DashboardOutline | undefined> {
    const [page] = await Dashboard.listOutlines(caller, { topicId, page: 'topic' });
    return page;
  }

  /** What instantiating the persona would do, without writing (403 for a viewer, 404 unknown). */
  static async plan(caller: Caller, input: InstantiatePersonaInput): Promise<PersonaPlan> {
    Persona.Operation.assert(caller);
    return Persona.#of(input.personaKey).#plan(caller, input);
  }

  /**
   * Makes (or completes) the persona's topics. Safe to repeat: a second run changes nothing. A
   * failure part-way leaves what was made; running it again finishes the rest.
   */
  static async instantiate(
    caller: Caller,
    input: InstantiatePersonaInput,
  ): Promise<PersonaInstantiateResult> {
    Persona.Operation.assert(caller);
    return Persona.#of(input.personaKey).#instantiate(caller, input);
  }

  async #plan(caller: Caller, input: InstantiatePersonaInput): Promise<PersonaPlan> {
    const topics = await Topic.list(caller.workspaceId);
    const planned: PersonaPlan['topics'] = [];
    for (const topic of this.#file.topics) {
      const existing = topics.find((entry) => entry.slug === topic.slug);
      const page = existing === undefined ? undefined : await Persona.#pageOf(caller, existing.id);
      const have = viewTemplatesOf(page);
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
      input.shareIntegrations === false ? [] : await Dashboard.templateShares(caller, [this.key]);
    return { personaKey: this.key, topics: planned, shares };
  }

  async #instantiate(
    caller: Caller,
    input: InstantiatePersonaInput,
  ): Promise<PersonaInstantiateResult> {
    const language: TopicLanguage = input.language;
    const result: PersonaInstantiateResult = { personaKey: this.key, topics: [] };

    for (const planned of this.#file.topics) {
      const existing = (await Topic.list(caller.workspaceId)).find(
        (topic) => topic.slug === planned.slug,
      );
      const topic =
        existing ??
        (await Topic.create(caller, {
          name: planned.names[language],
          icon: planned.icon,
          colour: planned.colour,
          slug: planned.slug,
        }));

      const page = await Persona.#pageOf(caller, topic.id);
      const pageCreated = page === undefined;
      let dashboardId: string;
      let version: number;
      if (page === undefined) {
        const templateKey = resolveTemplateKey(planned.page);
        if (templateKey === null) {
          throw new AppError(500, 'A persona names an unknown page template');
        }
        const created = await Dashboard.create(caller, {
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

      const have = viewTemplatesOf(page);
      const viewsAdded: string[] = [];
      for (const viewKey of planned.views) {
        const key = resolveViewTemplateKey(viewKey);
        if (key === null || have.has(key)) continue;
        const dashboard = await Dashboard.load(caller, dashboardId, Dashboard.Operation.edit);
        const written = await dashboard.applyOps(caller, {
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
}
