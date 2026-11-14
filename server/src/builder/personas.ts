/**
 * Persona templates (H6, D7): data, not code. Each JSON file in `templates/personas/` is a set of
 * topics, each with its page (a dashboard template) and its views (view templates). Instantiating
 * one (services/personas.ts) is idempotent per topic slug: a topic that exists is reused, a page
 * that exists is kept, and a view is added only when the page has none from the same template.
 *
 * The gallery lists them smallest first: the order of PERSONAS below.
 */
import { z } from 'zod';

import { TOPIC_COLOURS, TOPIC_ICONS } from '../types/topics.js';
import type { PersonaSummary } from '../types/dashboards.js';
import { listTemplates, resolveTemplateKey } from './templates.js';
import lightStudent from './templates/personas/light-student.json' with { type: 'json' };
import studentJob from './templates/personas/student-job.json' with { type: 'json' };
import twoJobs from './templates/personas/two-jobs-studies-side-project.json' with { type: 'json' };
import { listViewTemplates, resolveViewTemplateKey } from './viewTemplates.js';

const LocalizedSchema = z.strictObject({
  en: z.string().min(1).max(200),
  he: z.string().min(1).max(200),
});

const PERSONA_KEY_PATTERN = /^([a-z][a-z0-9-]*)@([1-9][0-9]*)$/;

const PersonaTopicSchema = z.strictObject({
  slug: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  names: LocalizedSchema,
  icon: z.enum(TOPIC_ICONS),
  colour: z.enum(TOPIC_COLOURS),
  /** The dashboard template of the topic's page. */
  page: z.string().min(1).max(80),
  /** View templates, in tab order. */
  views: z.array(z.string().min(1).max(80)).max(10),
});

const PersonaFileSchema = z
  .strictObject({
    key: z.string().regex(PERSONA_KEY_PATTERN),
    version: z.int().min(1),
    titles: LocalizedSchema,
    descriptions: LocalizedSchema,
    topics: z.array(PersonaTopicSchema).min(1).max(10),
  })
  .refine((file) => file.key.endsWith(`@${String(file.version)}`), {
    message: 'the key ends with @<version>',
    path: ['key'],
  })
  .refine(
    (file) => {
      const pages = new Map(listTemplates().map((template) => [template.key, template.scope.page]));
      return file.topics.every((topic) => {
        const page = resolveTemplateKey(topic.page);
        return (
          page !== null &&
          pages.get(page) === 'topic' &&
          topic.views.every((view) => resolveViewTemplateKey(view) !== null)
        );
      });
    },
    {
      message: 'every page is a topic page template and every view a view template',
      path: ['topics'],
    },
  );
export type PersonaFile = z.infer<typeof PersonaFileSchema>;

/** Smallest first (Shalev's gallery order): Light student, Two jobs + studies + side project, Student + job. */
const PERSONAS: ReadonlyMap<string, PersonaFile> = new Map(
  [lightStudent, twoJobs, studentJob].map((file) => {
    const parsed = PersonaFileSchema.parse(file);
    return [parsed.key, parsed];
  }),
);

/** The persona a key names (exact, or a bare name = latest), or null. */
export function resolvePersonaKey(key: string): string | null {
  const name = key.toLowerCase();
  if (PERSONAS.has(name)) return name;
  if (name.includes('@')) return null;
  let latest: PersonaFile | null = null;
  for (const persona of PERSONAS.values()) {
    const [, personaName] = PERSONA_KEY_PATTERN.exec(persona.key) ?? [];
    if (personaName === name && (latest === null || persona.version > latest.version)) {
      latest = persona;
    }
  }
  return latest?.key ?? null;
}

export function getPersona(key: string): PersonaFile | null {
  const resolved = resolvePersonaKey(key);
  return resolved === null ? null : (PERSONAS.get(resolved) ?? null);
}

/** Every dashboard template and view template a persona instantiates, each key once. */
export function personaTemplateKeys(persona: PersonaFile): { pages: string[]; views: string[] } {
  const pages = new Set<string>();
  const views = new Set<string>();
  for (const topic of persona.topics) {
    const page = resolveTemplateKey(topic.page);
    if (page !== null) pages.add(page);
    for (const view of topic.views) {
      const resolved = resolveViewTemplateKey(view);
      if (resolved !== null) views.add(resolved);
    }
  }
  return { pages: [...pages], views: [...views] };
}

export function listPersonas(): PersonaSummary[] {
  const viewTemplates = new Map(listViewTemplates().map((view) => [view.key, view]));
  return [...PERSONAS.values()].map((persona) => ({
    key: persona.key,
    version: persona.version,
    titles: { ...persona.titles },
    descriptions: { ...persona.descriptions },
    topics: persona.topics.map((topic) => ({
      slug: topic.slug,
      names: { ...topic.names },
      icon: topic.icon,
      colour: topic.colour,
      page: resolveTemplateKey(topic.page) ?? topic.page,
      views: topic.views.flatMap((key) => {
        const view = viewTemplates.get(resolveViewTemplateKey(key) ?? '');
        return view === undefined
          ? []
          : [{ key: view.key, titles: { ...view.titles }, type: view.type }];
      }),
    })),
  }));
}
