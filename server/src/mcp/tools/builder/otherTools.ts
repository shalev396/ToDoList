/**
 * The builder writes outside D12: a new dashboard (nothing to preview it against), undo (this
 * agent's own changes, guarded), and publish (builder:publish, owners, the workspace setting).
 */
import { z } from 'zod';

import { Dashboard, Persona } from '../../../classes/dashboard/index.js';
import { MAX_UNDO_STEPS } from '../../../classes/dashboard/limits.js';
import { AppError } from '../../../errors/AppError.js';
import { VarNameSchema } from '../../../types/builder.js';
import { DASHBOARD_PAGES } from '../../../types/domain.js';
import { TopicRef, topicIdOf } from '../itemViews.js';
import { defineTool } from '../../tool.js';
import {
  actorOf,
  builderCaller,
  dashboardFor,
  DashboardId,
  DashboardView,
  Diff,
  DryRun,
  ExpectedVersion,
  json,
  Language,
  Preview,
  Shares,
  sharesSentence,
  WriteOutput,
} from './common.js';

/** builder_create_dashboard's answer: the dashboard, or with dryRun the one it would create. */
const CreateOutput = DashboardView.extend({
  id: z.string().nullable().describe('null: a dry run, nothing was created'),
  applied: z.boolean().describe('false: a dry run, nothing was written'),
  preview: Preview,
  shares: Shares,
  summary: z.string(),
});

export const builderCreateDashboard = defineTool({
  name: 'builder_create_dashboard',
  title: 'Create a dashboard',
  description:
    "Creates a dashboard or topic page, blank (a title is then required) or fromTemplate (a template key or name from builder_list_templates, titles in language). scope sets its topic (a slug, as workspace_get lists them; null: the main dashboard), page (topic or group) and, for a group page, its route variable. It starts as an unpublished draft at version 1. A template's data blocks read the key user's own integrations that match them: attaching one for the first time shares its items with everyone in the workspace. Run it with dryRun: true first; shares names what would become shared, and shareIntegrations: false creates it without them.",
  toolset: 'builder',
  inputSchema: z.strictObject({
    title: z.string().min(1).max(80).optional(),
    scope: z
      .strictObject({
        topic: TopicRef.nullable().optional(),
        containerId: z.string().min(1).max(100).nullable().optional(),
        page: z.enum(DASHBOARD_PAGES).optional(),
        groupVar: VarNameSchema.nullable().optional(),
      })
      .optional(),
    fromTemplate: z.string().min(1).max(80).optional().describe('e.g. college@1, or college'),
    language: Language.default('en'),
    shareIntegrations: z
      .boolean()
      .default(true)
      .describe(
        "false: the template binds only the key user's integrations that are already shared, so creating it shares nothing new",
      ),
    dryRun: DryRun,
  }),
  outputSchema: CreateOutput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  scopes: ['builder:write'],
  minRole: 'editor',
  async handler(ctx, raw) {
    const actor = actorOf(ctx);
    const { scope: given, ...rest } = raw;
    const input = {
      ...rest,
      ...(given === undefined
        ? {}
        : {
            scope: {
              containerId: given.containerId,
              page: given.page,
              groupVar: given.groupVar,
              ...(given.topic === undefined
                ? {}
                : { topicId: await topicIdOf(ctx.workspace, given.topic) }),
            },
          }),
    };
    if (input.dryRun) {
      const planned = await Dashboard.previewCreate(builderCaller(ctx), input);
      const { title, scope, vars, layouts, blocks } = planned.draft;
      const output = json(CreateOutput, {
        id: null,
        as: 'draft',
        title,
        scope: { ...scope, groupVar: scope.groupVar ?? null },
        templateKey: planned.templateKey,
        visibility: 'workspace',
        vars,
        layouts,
        blocks,
        views: planned.draft.views ?? [],
        version: 1,
        publishedVersion: null,
        updatedBy: actor,
        updatedAt: ctx.now(),
        applied: false,
        preview: planned.preview,
        shares: planned.shares,
        summary: `Preview: nothing was created.${sharesSentence(planned.shares)}`,
      });
      return { output, preview: true };
    }
    const view = await Dashboard.create(builderCaller(ctx), input);
    const output = json(CreateOutput, {
      ...view,
      applied: true,
      preview: {},
      shares: [],
      summary: 'Created: an unpublished draft at version 1.',
    });
    return { output, target: { type: 'dashboard', id: view.id } };
  },
});

const PersonaOutput = z.object({
  applied: z.boolean().describe('false: a dry run, nothing was created'),
  topics: z.array(
    z.object({
      slug: z.string(),
      name: z.string().optional(),
      topicExists: z.boolean().optional().describe('Dry run: the topic exists and is reused'),
      pageExists: z.boolean().optional().describe('Dry run: its page exists and keeps its blocks'),
      created: z.boolean().optional().describe('Written: the topic was made now'),
      pageCreated: z.boolean().optional().describe('Written: the page was made now'),
      dashboardId: z.string().optional().describe('Written: the topic’s page'),
      views: z.array(z.string()).describe('The view templates added (or, in a dry run, to add)'),
    }),
  ),
  shares: Shares,
  summary: z.string(),
});

export const builderInstantiatePersona = defineTool({
  name: 'builder_instantiate_persona',
  title: 'Create a persona’s pages',
  description:
    "Creates a persona template's topics, pages, views and blocks (builder_list_templates personas: light-student@1, two-jobs-studies-side-project@1, student-job@1). Idempotent: a topic with the same slug is reused, a page keeps its blocks, and a view is added only when the page has none from the same template, so running it twice changes nothing. The blocks read the key user's own integrations that match them; attaching one for the first time shares its items with everyone in the workspace. Run it with dryRun: true first; shares names what would become shared, and shareIntegrations: false creates it without them. The pages start as drafts.",
  toolset: 'builder',
  inputSchema: z.strictObject({
    personaKey: z.string().min(1).max(80).describe('e.g. light-student@1, or light-student'),
    language: Language.default('en'),
    shareIntegrations: z
      .boolean()
      .default(true)
      .describe(
        "false: bind only the key user's integrations that are already shared, so creating it shares nothing new",
      ),
    dryRun: DryRun,
  }),
  outputSchema: PersonaOutput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['builder:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const caller = builderCaller(ctx);
    const request = {
      personaKey: input.personaKey,
      language: input.language,
      shareIntegrations: input.shareIntegrations,
    };
    if (input.dryRun) {
      const plan = await Persona.plan(caller, request);
      return {
        output: json(PersonaOutput, {
          applied: false,
          topics: plan.topics,
          shares: plan.shares,
          summary: `Preview: nothing was created.${sharesSentence(plan.shares)}`,
        }),
        preview: true,
      };
    }
    const result = await Persona.instantiate(caller, request);
    return {
      output: json(PersonaOutput, {
        applied: true,
        topics: result.topics.map((topic) => ({
          slug: topic.slug,
          created: topic.created,
          pageCreated: topic.pageCreated,
          dashboardId: topic.dashboardId,
          views: topic.viewsAdded,
        })),
        shares: [],
        summary: 'Created: the pages are unpublished drafts.',
      }),
    };
  },
});

export const builderUndo = defineTool({
  name: 'builder_undo',
  title: 'Undo',
  description: `Reverts this agent's own last changes to the draft (steps, 1 to ${String(MAX_UNDO_STEPS)}), past anyone else's, as one new version. Refused when a later change edited the same blocks, or when there is nothing of this agent's to undo.`,
  toolset: 'builder',
  inputSchema: z.strictObject({
    dashboardId: DashboardId,
    expectedVersion: ExpectedVersion,
    steps: z.number().int().min(1).max(MAX_UNDO_STEPS).default(1),
    dryRun: DryRun,
  }),
  outputSchema: WriteOutput,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  scopes: ['builder:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const target = { type: 'dashboard', id: input.dashboardId };
    const undo = { expectedVersion: input.expectedVersion, steps: input.steps };
    if (input.dryRun) {
      const result = await (
        await dashboardFor(ctx, input.dashboardId, Dashboard.Operation.undo)
      ).previewUndo(builderCaller(ctx), undo);
      return {
        output: {
          applied: false,
          version: input.expectedVersion,
          valid: result.valid,
          errors: result.errors,
          warnings: result.warnings,
          diff: json(Diff, result.diff),
          preview: json(Preview, result.preview),
          shares: result.shares,
          addedBlockIds: [],
          summary: `Preview: nothing was written. Call again without dryRun to undo.${sharesSentence(result.shares)}`,
        },
        preview: true,
        target,
      };
    }
    const { version } = await (
      await dashboardFor(ctx, input.dashboardId, Dashboard.Operation.undo)
    ).undo(builderCaller(ctx), undo);
    return {
      output: {
        applied: true,
        version,
        valid: true,
        errors: [],
        warnings: [],
        diff: [],
        preview: {},
        shares: [],
        addedBlockIds: [],
        summary: `Undone: the draft is now version ${String(version)}.`,
      },
      target,
    };
  },
});

export const builderPublish = defineTool({
  name: 'builder_publish',
  title: 'Publish a dashboard',
  description:
    'Publishes the draft version you reviewed (expectedVersion): viewers see it from now on. Only when the workspace allows agents to publish (its allowAgentPublish setting, off by default), for an owner’s agent key with builder:publish. If anyone wrote since that version, nothing is published.',
  toolset: 'builder',
  inputSchema: z.strictObject({
    dashboardId: DashboardId,
    expectedVersion: ExpectedVersion,
    dryRun: DryRun,
  }),
  outputSchema: z.object({
    applied: z.boolean().describe('false: a dry run, nothing was published'),
    version: z.number().int(),
    publishedVersion: z.number().int().describe('The version viewers see now'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['builder:publish'],
  minRole: 'owner',
  async handler(ctx, input) {
    if (ctx.workspace.settings.allowAgentPublish !== true) {
      throw new AppError(
        403,
        'Agents may not publish in this workspace: an owner can turn on allowAgentPublish in its settings. The draft is saved; an owner can publish it in the app.',
      );
    }
    const result = await (
      await dashboardFor(ctx, input.dashboardId, Dashboard.Operation.publish)
    ).publish(builderCaller(ctx), {
      expectedVersion: input.expectedVersion,
      allowAgentPublish: true,
      dryRun: input.dryRun,
    });
    return {
      output: { ...result, applied: !input.dryRun },
      preview: input.dryRun,
      target: { type: 'dashboard', id: input.dashboardId },
    };
  },
});
