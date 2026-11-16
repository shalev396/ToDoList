/**
 * A dashboard being made (BUILDER.md §5, §9): blank, or from a template bound to the member's own
 * integrations (ruling 16). It plans the first draft (the template, the scope field by field, a
 * topic page's `$page.topic`, the group page's topic), checks it as a write does (DocCheck), and
 * writes it: the dashboard at version 1, its first history entry (a whole snapshot), an owner's UI
 * publish, the `dashboard.create` audit entry. A dry run, and what instantiating templates would
 * share (I4), come from the same plan.
 *
 * Dashboard.create, previewCreate, instantiate and templateShares call it; Dashboard keeps the life
 * of a dashboard once made (and makes its view).
 */
import { bindTemplateConnectors } from '../../builder/connectors.js';
import { OpValidationError } from '../../builder/errors.js';
import { getPersona, personaTemplateKeys } from '../../builder/personas.js';
import {
  instantiateTemplate,
  resolveTemplateKey,
  type TemplateLanguage,
} from '../../builder/templates.js';
import { localizeViewTemplate } from '../../builder/viewTemplates.js';
import type {
  CreateDashboardInput as CreateDashboardRow,
  DashboardData,
} from '../../models/definitions/Dashboard.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { getDashboardRepository } from '../../models/index.js';
import type { Block, DashboardDraft, Layouts } from '../../types/builder.js';
import type { BlockPreview, IntegrationShare } from '../../types/dashboards.js';
import type { DashboardPage } from '../../types/domain.js';
import { AuditTarget } from '../base/AuditTarget.js';
import type { Caller } from '../base/Caller.js';
import { AuditLog } from '../AuditLog.js';
import { ItemPolicy } from '../policies/ItemPolicy.js';
import { Topic } from '../workspace/Topic.js';
import { BlockPreviews } from './BlockPreviews.js';
import { DashboardConnectors } from './DashboardConnectors.js';
import {
  autoPublishes,
  DASHBOARD_AUDIT,
  DASHBOARD_OPERATIONS,
  lintModeOf,
  publishedCopy,
} from './dashboardRules.js';
import { DocCheck } from './DocCheck.js';
import { History } from './History.js';
import { Layout } from './Layout.js';

const MAIN_SCOPE = { topicId: null, containerId: null, page: 'topic', groupVar: null } as const;

/** The page variable a topic page's blocks filter on (`topic = $page.topic`). */
const TOPIC_VAR = 'topic';

// Optional inputs also accept `undefined`, so a parsed request body (zod) passes as it is.

export interface CreateDashboardInput {
  /** Required without a template; overrides the template's title otherwise. */
  title?: string | undefined;
  /** Overrides the template's (or the main dashboard's) scope, field by field. */
  scope?:
    | {
        /** The topic (page) it belongs to; null = the main dashboard. */
        topicId?: string | null | undefined;
        containerId?: string | null | undefined;
        page?: DashboardPage | undefined;
        /** A group page's route variable (`course` → `$page.course`): required on group pages. */
        groupVar?: string | null | undefined;
      }
    | undefined;
  /** A template key (`work@1`) or name (`work`). */
  fromTemplate?: string | undefined;
  /** The language of the template's titles. */
  language: TemplateLanguage;
  /**
   * false: a template binds only the actor's integrations that are already shared, so creating
   * shares nothing new (the UI's "Create without them", after templateShares). Default: true.
   */
  shareIntegrations?: boolean | undefined;
}

export interface InstantiateDashboardInput {
  templateKey: string;
  language: TemplateLanguage;
  /** Overrides the template's scope (a topic page and project@1 need a topic). */
  scope?: CreateDashboardInput['scope'];
  shareIntegrations?: boolean | undefined;
}

/** What a create would write (builder_create_dashboard's dry run). */
export interface CreatePreview {
  draft: DashboardDraft;
  templateKey: string | null;
  preview: Record<string, BlockPreview>;
  shares: IntegrationShare[];
}

/** A create from a template, as `write` takes it. */
function createInputOf(input: InstantiateDashboardInput): CreateDashboardInput {
  return {
    fromTemplate: input.templateKey,
    language: input.language,
    scope: input.scope,
    shareIntegrations: input.shareIntegrations,
  };
}

/** A new dashboard's first history entry's summary. */
function createdSummary(templateKey: string | null): string {
  return templateKey === null ? 'create' : `create ${templateKey}`;
}

/** A new dashboard's `dashboard.create` audit meta. */
function createdMeta(version: number, templateKey: string | null): Record<string, unknown> {
  return { version, templateKey };
}

/** The first draft and its template key, before the member's integrations are bound. */
function initialDraft(input: CreateDashboardInput): {
  draft: DashboardDraft;
  templateKey: string | null;
} {
  let base: DashboardDraft;
  let templateKey: string | null = null;
  if (input.fromTemplate !== undefined) {
    templateKey = resolveTemplateKey(input.fromTemplate);
    if (templateKey === null) {
      throw new OpValidationError('/fromTemplate', 'no template with this key');
    }
    base = instantiateTemplate(templateKey, { language: input.language });
  } else {
    if (input.title === undefined) {
      throw new OpValidationError('/title', 'a dashboard without a template needs a title');
    }
    base = {
      title: input.title,
      scope: { ...MAIN_SCOPE },
      vars: {},
      layouts: Layout.EMPTY.toJSON() as Layouts,
      blocks: [],
    };
  }
  const { scope } = input;
  const topicId = scope?.topicId === undefined ? base.scope.topicId : scope.topicId;
  // A page of a topic binds its `$page.topic` default to that topic (templates leave it unset).
  const bindsTopic =
    topicId !== null &&
    Object.hasOwn(base.vars, TOPIC_VAR) &&
    (base.vars[TOPIC_VAR] ?? null) === null;
  return {
    templateKey,
    draft: {
      ...base,
      title: input.title ?? base.title,
      vars: bindsTopic ? { ...base.vars, [TOPIC_VAR]: topicId } : base.vars,
      scope: {
        topicId,
        containerId: scope?.containerId === undefined ? base.scope.containerId : scope.containerId,
        page: scope?.page ?? base.scope.page,
        groupVar: scope?.groupVar === undefined ? (base.scope.groupVar ?? null) : scope.groupVar,
      },
    },
  };
}

export class NewDashboard {
  readonly #caller: Caller;

  private constructor(caller: Caller) {
    this.#caller = caller;
    Object.freeze(this);
  }

  /** A dashboard the caller makes in their workspace. */
  static for(caller: Caller): NewDashboard {
    return new NewDashboard(caller);
  }

  /**
   * The draft a create would write, checked as the create checks it. A template's blocks are bound
   * to the actor's own integrations that match their provider hints (ruling 16), only the shared
   * ones with `shareIntegrations: false`.
   */
  async #planned(
    input: CreateDashboardInput,
  ): Promise<{ draft: DashboardDraft; templateKey: string | null }> {
    const caller = this.#caller;
    DASHBOARD_OPERATIONS.create.assert(caller);
    const planned = initialDraft(input);
    const bindable =
      planned.templateKey === null
        ? []
        : await DashboardConnectors.of(caller).bindable(input.shareIntegrations !== false);
    return this.#checked(planned, bindable);
  }

  /**
   * The first draft bound to `bindable` (a template's blocks, ruling 16) and checked as a write
   * checks it.
   */
  #checked(
    planned: { draft: DashboardDraft; templateKey: string | null },
    bindable: readonly IntegrationData[],
  ): { draft: DashboardDraft; templateKey: string | null } {
    const { templateKey } = planned;
    const initial =
      templateKey === null ? planned.draft : bindTemplateConnectors(planned.draft, [...bindable]);
    // A group page (one course, one project) belongs to one topic; project@1 leaves it to the caller.
    if (initial.scope.page === 'group' && initial.scope.topicId === null) {
      throw new OpValidationError(
        '/scope/topicId',
        'scope.topicId required: a group page belongs to one topic',
      );
    }
    return { draft: DocCheck.instance.validated(initial, lintModeOf(this.#caller)), templateKey };
  }

  /**
   * What `write` would write, without writing (builder_create_dashboard's dry run): the draft, its
   * template, preview rows per block (`previewRows`: 0 to CAPS.previewRows), and what creating it
   * would share with the whole workspace (`shares`).
   */
  async preview(
    input: CreateDashboardInput & { previewRows?: number | undefined },
  ): Promise<CreatePreview> {
    const caller = this.#caller;
    const { draft, templateKey } = await this.#planned(input);
    if (draft.scope.topicId !== null) await Topic.assertOf(caller.workspaceId, draft.scope.topicId);
    return {
      draft,
      templateKey,
      preview: await BlockPreviews.for(caller).of(draft, input.previewRows),
      shares: await DashboardConnectors.of(caller).sharesOf([], draft.blocks),
    };
  }

  /**
   * A new dashboard, blank or from a template, at version 1 with a full snapshot in its history. An
   * owner creating it in the UI publishes it at once. Returns it as stored.
   */
  async write(input: CreateDashboardInput): Promise<DashboardData> {
    const caller = this.#caller;
    const { draft, templateKey } = await this.#planned(input);
    if (draft.scope.topicId !== null) await Topic.assertOf(caller.workspaceId, draft.scope.topicId);
    await DashboardConnectors.of(caller).assert([], draft.blocks);
    const { actor } = caller;
    const dashboards = await getDashboardRepository();
    const created = await dashboards.create(caller.workspaceId, this.#stored(draft, templateKey));
    ItemPolicy.forget(caller.workspaceId);
    await History.of<DashboardDraft>(caller.workspaceId, created.id).start(
      created.version,
      draft,
      actor,
      createdSummary(templateKey),
    );
    const result = autoPublishes(caller)
      ? ((await dashboards.setPublished(
          caller.workspaceId,
          created.id,
          created.version,
          publishedCopy(draft),
        )) ?? created)
      : created;
    await AuditLog.record(
      caller,
      DASHBOARD_AUDIT.create,
      AuditTarget.of('dashboard', created.id),
      createdMeta(created.version, templateKey),
    );
    return result;
  }

  /**
   * New dashboards as `write` makes each, in a handful of round trips whatever their number: the
   * member's integrations, the topics and the blocks' connectors read once; the dashboards, their
   * first history entries, an owner's publish and the audit entries each written at once. They
   * are created in the order given (each a millisecond after the one before it), so they list in
   * that order. Answers their ids.
   */
  async writeAll(inputs: readonly CreateDashboardInput[]): Promise<string[]> {
    const caller = this.#caller;
    DASHBOARD_OPERATIONS.create.assert(caller);
    if (inputs.length === 0) return [];
    const connectors = DashboardConnectors.of(caller);
    const bindable = new Map<boolean, Promise<IntegrationData[]>>();
    const plans: { draft: DashboardDraft; templateKey: string | null }[] = [];
    for (const input of inputs) {
      const planned = initialDraft(input);
      const share = input.shareIntegrations !== false;
      if (planned.templateKey !== null && !bindable.has(share)) {
        bindable.set(share, connectors.bindable(share));
      }
      const own = planned.templateKey === null ? [] : await (bindable.get(share) ?? []);
      plans.push(this.#checked(planned, own));
    }
    const { workspaceId, actor } = caller;
    await Topic.assertAllOf(workspaceId, [
      ...new Set(plans.flatMap(({ draft }) => draft.scope.topicId ?? [])),
    ]);
    await connectors.assertEach(plans.map(({ draft }) => draft.blocks));
    const dashboards = await getDashboardRepository();
    const created = await dashboards.createMany(
      workspaceId,
      plans.map(({ draft, templateKey }) => this.#stored(draft, templateKey)),
    );
    ItemPolicy.forget(workspaceId);
    const written = created.map((data, index) => {
      const plan = plans[index];
      if (plan === undefined) throw new Error('NewDashboard.writeAll: a dashboard is missing');
      return { data, ...plan };
    });
    await History.startAll<DashboardDraft>(
      workspaceId,
      written.map(({ data, draft, templateKey }) => ({
        documentId: data.id,
        version: data.version,
        doc: draft,
        author: actor,
        summary: createdSummary(templateKey),
      })),
    );
    if (autoPublishes(caller)) {
      await dashboards.setPublishedMany(
        workspaceId,
        written.map(({ data, draft }) => ({
          id: data.id,
          version: data.version,
          snapshot: publishedCopy(draft),
        })),
      );
    }
    await AuditLog.recordAll(
      caller,
      written.map(({ data, templateKey }) => ({
        action: DASHBOARD_AUDIT.create,
        target: AuditTarget.of('dashboard', data.id),
        meta: createdMeta(data.version, templateKey),
      })),
    );
    return created.map(({ id }) => id);
  }

  /** What a new dashboard stores of its checked draft, as the caller's. */
  #stored(draft: DashboardDraft, templateKey: string | null): CreateDashboardRow {
    const { actor } = this.#caller;
    return {
      ownerUserId: actor.userId,
      title: draft.title,
      scope: { ...draft.scope, groupVar: draft.scope.groupVar ?? null },
      templateKey,
      vars: draft.vars,
      layouts: draft.layouts,
      blocks: draft.blocks,
      importance: draft.importance ?? null,
      views: draft.views ?? [],
      updatedBy: { userId: actor.userId, agentId: actor.agentId },
    };
  }

  /** A new dashboard from a template (`POST …/builder/instantiate`): `write`, the key's pointer named. */
  async writeFromTemplate(input: InstantiateDashboardInput): Promise<DashboardData> {
    return NewDashboard.#templateKeyPointer(() => this.write(createInputOf(input)));
  }

  /** New dashboards from templates, as `writeAll` makes them; the key's pointer named. */
  async writeAllFromTemplates(inputs: readonly InstantiateDashboardInput[]): Promise<string[]> {
    return NewDashboard.#templateKeyPointer(() => this.writeAll(inputs.map(createInputOf)));
  }

  /** A template key's problem, as the instantiate request names it (`/templateKey`). */
  static async #templateKeyPointer<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof OpValidationError && error.pointer === '/fromTemplate') {
        throw new OpValidationError('/templateKey', error.reason);
      }
      throw error;
    }
  }

  /**
   * What instantiating these templates would share (I4: never silently): the actor's own live
   * integrations a template block would be bound to that no block holds yet, each once, oldest
   * first. The UI asks before creating ("Share and create" or "Create without them", the latter
   * passing `shareIntegrations: false`); agents see the same list in a dry run's `shares`.
   */
  async templateShares(templateKeys: readonly string[]): Promise<IntegrationShare[]> {
    const caller = this.#caller;
    DASHBOARD_OPERATIONS.create.assert(caller);
    // A key names a dashboard template, a view template or a persona (a set of both).
    const drafts = templateKeys.flatMap((key, index): { blocks: Block[] }[] => {
      const page = resolveTemplateKey(key);
      if (page !== null) return [instantiateTemplate(page, { language: 'en' })];
      const view = localizeViewTemplate(key, 'en');
      if (view !== null) return [view];
      const persona = getPersona(key);
      if (persona === null) {
        throw new OpValidationError(`/templateKeys/${String(index)}`, 'no template with this key');
      }
      const { pages, views } = personaTemplateKeys(persona);
      return [
        ...pages.map((name) => instantiateTemplate(name, { language: 'en' })),
        ...views.flatMap((name) => localizeViewTemplate(name, 'en') ?? []),
      ];
    });
    return DashboardConnectors.of(caller).templateShares(drafts);
  }
}
