import { z } from 'zod';

import { listAttributes } from '../../../services/attributes.js';
import { ATTRIBUTE_TYPES } from '../../../types/attributes.js';
import { defineTool } from '../../tool.js';

export const listAttributesTool = defineTool({
  name: 'list_attributes',
  title: 'List custom attributes',
  description:
    'The workspace’s custom attributes: fields every item can carry, such as the built-in Importance (a rating from 1 to 5; an item without a value counts as 3). Use the key in a query as `attr.<key>` (filter, sort, group) and in set_item_attributes. Values are local data, never written to a provider.',
  toolset: 'items',
  inputSchema: z.strictObject({}),
  outputSchema: z.object({
    attributes: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        type: z.enum(ATTRIBUTE_TYPES),
        options: z
          .array(z.string())
          .optional()
          .describe('select and multiSelect: the allowed values'),
        min: z.number().optional(),
        max: z.number().optional(),
        builtIn: z.boolean().describe('The built-in Importance cannot be deleted'),
      }),
    ),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['read'],
  minRole: 'viewer',
  handler(ctx) {
    return Promise.resolve({ output: { attributes: listAttributes(ctx.workspace) } });
  },
});
