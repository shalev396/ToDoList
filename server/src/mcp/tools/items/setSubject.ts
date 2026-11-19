import { z } from 'zod';

import { Workspace } from '../../../classes/workspace/index.js';
import { NameSchema, PatternsSchema } from '../../../types/attributes.js';
import { TOPIC_COLOURS } from '../../../types/topics.js';
import { toolCaller } from '../../auth/principal.js';
import { defineTool } from '../../tool.js';

export const setSubject = defineTool({
  name: 'set_subject',
  title: 'Create or change a Subject',
  description:
    'Creates a Subject (a lesson, a project: an option of the workspace’s Subject attribute, which is created on first use) or changes one: its colour family, the title patterns that pick it (* matches any run of characters, at most 8 per pattern) and, with rename, its name; items with that Subject follow a rename. A new Subject without a family gets the next free one. Returns the Subject and whether it was created. Subjects are kept in TodoList only.',
  toolset: 'items',
  inputSchema: z.strictObject({
    name: NameSchema.describe('The Subject to create or change'),
    rename: NameSchema.optional().describe('A new name for an existing Subject'),
    family: z.enum(TOPIC_COLOURS).optional(),
    patterns: PatternsSchema.optional().describe(
      'Titles that pick this Subject, e.g. "*calculus*"',
    ),
    attributeName: NameSchema.optional().describe(
      'What the first Subject names the attribute (default "Subject")',
    ),
  }),
  outputSchema: z.object({
    subject: z.object({
      name: z.string(),
      family: z.enum(TOPIC_COLOURS),
      patterns: z.array(z.string()),
    }),
    created: z.boolean(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['items:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const caller = toolCaller(ctx);
    const workspace = await Workspace.load(caller);
    const { subject, created } = await workspace.upsertSubject(caller, input);
    return {
      output: {
        subject: { name: subject.name, family: subject.family, patterns: [...subject.patterns] },
        created,
      },
      target: { type: 'attribute', id: 'subject' },
    };
  },
});
