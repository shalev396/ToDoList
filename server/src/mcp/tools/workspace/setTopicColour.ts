import { z } from 'zod';

import { Topic } from '../../../classes/workspace/index.js';
import { TOPIC_COLOURS } from '../../../types/topics.js';
import { toolCaller } from '../../auth/principal.js';
import { defineTool } from '../../tool.js';
import { TopicRef, topicIds } from '../itemViews.js';

export const setTopicColour = defineTool({
  name: 'set_topic_colour',
  title: 'Set a topic’s colour family',
  description:
    'Gives a topic (a page: Work, College…) its colour family; every clock, calendar and task view colours that topic’s items with it (a Subject’s own colour wins for items that have one). Returns the topic with its family. Owner only.',
  toolset: 'workspace',
  inputSchema: z.strictObject({ topic: TopicRef, family: z.enum(TOPIC_COLOURS) }),
  outputSchema: z.object({
    topic: z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      family: z.enum(TOPIC_COLOURS).nullable(),
    }),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['workspace:share'],
  minRole: 'owner',
  async handler(ctx, input) {
    const [topicId] = (await topicIds(ctx.workspace, [input.topic])) ?? [];
    if (topicId === undefined) throw new Error('Unknown topic');
    const topic = await Topic.update(toolCaller(ctx), topicId, { colour: input.family });
    return {
      output: {
        topic: { id: topic.id, slug: topic.slug, name: topic.name, family: topic.colour },
      },
      target: { type: 'topic', id: topic.id },
    };
  },
});
