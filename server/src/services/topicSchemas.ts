/** Request bodies of the topic routes (zod 4). Strict objects: an unknown key is a 400. */
import { z } from 'zod';

import { TOPIC_COLOURS, TOPIC_ICONS, TOPIC_NAME_MAX } from '../types/topics.js';

const Name = z.string().trim().min(1).max(TOPIC_NAME_MAX);
const Icon = z.enum(TOPIC_ICONS).nullable();
const Colour = z.enum(TOPIC_COLOURS).nullable();

export const CreateTopicBody = z.strictObject({
  name: Name,
  icon: Icon.optional(),
  colour: Colour.optional(),
  /** A topic-page template key or name (`work@1`, `Personal`); none = an empty page. */
  templateKey: z.string().min(1).max(80).optional(),
  language: z.enum(['en', 'he']).optional(),
  /** false: the template binds only the integrations already shared ("Create without them"). */
  shareIntegrations: z.boolean().optional(),
});

export const UpdateTopicBody = z
  .strictObject({
    name: Name.optional(),
    icon: Icon.optional(),
    colour: Colour.optional(),
    order: z.int().min(-1_000_000).max(1_000_000).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'At least one change is required');
