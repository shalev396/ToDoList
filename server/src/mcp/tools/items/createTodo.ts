import { createHash } from 'node:crypto';
import { z } from 'zod';

import { AppError } from '../../../errors/AppError.js';
import { CreateTargetsInput } from '../../../services/providerCreate/schemas.js';
import { createCopy } from '../../../services/providerCreate/service.js';
import { PROVIDERS_CREATE_SCOPE } from '../../../types/providerCreate.js';
import { toolCaller } from '../../auth/principal.js';
import { confirmField } from '../../middleware/confirm.js';

import { CreateItemBody } from '../../../services/itemSchemas.js';
import { createItem } from '../../../services/items.js';
import { defineTool } from '../../tool.js';
import { ItemDetailView, TopicRef, toItemDetailView, topicIdOf } from '../itemViews.js';

export function toDate(value: string | null | undefined): Date | null | undefined {
  return value === undefined || value === null ? value : new Date(value);
}

export const createTodo = defineTool({
  name: 'create_todo',
  title: 'Create a to-do',
  description:
    'Creates a local to-do (an item owned by TodoList, not mirrored from a provider): title, and optionally a note, due date, topic (a slug, as workspace_get lists them; null: Unsorted), container and priority (0–4). With an idempotencyKey, a retry gives back the to-do the first call made instead of a second one. The topic defaults to the workspace’s personal topic when it has one. With `targets` it also creates the to-do in the user’s own providers (Jira, ClickUp, Linear, GitHub, Google Calendar: each target is the integration and its typed choices, as the app’s funnel picks them); that needs `confirm: true` and the providers:create scope, and each target’s result is in `providerCopies`. At most one target per integration. It only creates: nothing at a provider is ever edited, closed or deleted. A target that failed is retried by calling again with a NEW idempotencyKey (the same key gives back the stored result); one that may exist (`unknown`) should be checked at the provider first.',
  toolset: 'items',
  inputSchema: CreateItemBody.omit({ topicId: true }).extend({
    topic: TopicRef.nullable().optional(),
    idempotencyKey: CreateItemBody.shape.idempotencyKey.describe(
      'Makes retries safe: the same key gives back the same to-do',
    ),
    targets: CreateTargetsInput.optional().describe(
      'Also create it in these of the caller’s own provider integrations (needs confirm and providers:create)',
    ),
    confirm: confirmField,
  }),
  outputSchema: z.object({
    item: ItemDetailView,
    created: z
      .boolean()
      .describe('false: a retry with an idempotencyKey already used; nothing new was made'),
    providerCopies: z
      .array(
        z.object({
          integrationId: z.string(),
          status: z.enum(['created', 'unknown', 'failed', 'needs_permission']),
          key: z.string().nullable(),
          url: z.string().nullable(),
          reason: z.string().nullable(),
        }),
      )
      .optional()
      .describe('One per target, in order; `unknown` may exist at the provider: check there'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  scopes: ['items:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const { topic, targets, confirm, ...fields } = input;
    const wanted = targets ?? [];
    if (wanted.length > 0) {
      if (!ctx.principal.scopes.includes(PROVIDERS_CREATE_SCOPE)) {
        throw new AppError(403, 'Creating in providers needs the providers:create scope');
      }
      if (confirm !== true) {
        throw new AppError(400, 'targets create items at providers: call again with confirm: true');
      }
    }
    const { item, created } = await createItem(ctx.workspace, ctx.principal.userId, {
      ...fields,
      dueAt: toDate(input.dueAt),
      topicId: await topicIdOf(ctx.workspace, topic),
    });
    const providerCopies: {
      integrationId: string;
      status: 'created' | 'unknown' | 'failed' | 'needs_permission';
      key: string | null;
      url: string | null;
      reason: string | null;
    }[] = [];
    for (const { integrationId, target } of wanted) {
      // The same key and integration always make the same request: a retry never creates twice.
      const requestId = createHash('sha256')
        .update(`${item.id}|${integrationId}|${input.idempotencyKey ?? ''}`)
        .digest('base64url')
        .slice(0, 40);
      try {
        const outcome = await createCopy(ctx.workspace, toolCaller(ctx).actor, item.id, {
          requestId,
          integrationId,
          target,
        });
        providerCopies.push({
          integrationId,
          status: outcome.status,
          key: outcome.copy.key,
          url: outcome.copy.url === '' ? null : outcome.copy.url,
          reason: outcome.status === 'failed' ? outcome.reason : null,
        });
      } catch (error) {
        // The to-do exists: a refused target (not yours, writes off, rate limit) is that target's result.
        if (!(error instanceof AppError)) throw error;
        providerCopies.push({
          integrationId,
          status: 'failed',
          key: null,
          url: null,
          reason: error.code ?? `http_${String(error.statusCode)}`,
        });
      }
    }
    return {
      output: {
        item: toItemDetailView(item),
        created,
        ...(wanted.length > 0 ? { providerCopies } : {}),
      },
      target: { type: 'item', id: item.id },
    };
  },
});
