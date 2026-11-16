/**
 * Dashboard templates (BUILDER.md §7, FRONTEND.md §1): data, not code. Each JSON file in
 * `templates/` is one dashboard with its titles in English and Hebrew and its variables unbound
 * (`$page.*`), so it works in any workspace. Imported statically, so the Lambda bundle holds them.
 *
 * A template block carries `titles: {en, he}` where a dashboard block has `title`. Instantiating
 * picks one language and gives every block a fresh id; the layouts follow the new ids.
 */
import { z } from 'zod';

import {
  CAPS,
  DashboardScopeSchema,
  DashboardVarsSchema,
  LayoutsSchema,
  type Block,
  type BlockType,
  type DashboardDraft,
} from '../types/builder.js';
import type { TemplateSummary } from '../types/dashboards.js';
import { OpValidationError } from './errors.js';
import { newBlockId, remapBlockIds } from './ops.js';
import college from './templates/college.json' with { type: 'json' };
import collegeCourse from './templates/college-course.json' with { type: 'json' };
import dashboard from './templates/dashboard.json' with { type: 'json' };
import personal from './templates/personal.json' with { type: 'json' };
import project from './templates/project.json' with { type: 'json' };
import work from './templates/work.json' with { type: 'json' };

export const TEMPLATE_LANGUAGES = ['en', 'he'] as const;
export type TemplateLanguage = (typeof TEMPLATE_LANGUAGES)[number];

const TitlesSchema = z.strictObject({
  en: z.string().min(1).max(80),
  he: z.string().min(1).max(80),
});

/** `<name>@<version>`, e.g. `college-course@1`. */
const TEMPLATE_KEY_PATTERN = /^([a-z][a-z0-9-]*)@([1-9][0-9]*)$/;
const MAX_ID_ATTEMPTS = 100;

/** A block as a template holds it: localized `titles` instead of `title` (checked when used). */
const TemplateBlockSchema = z
  .looseObject({ titles: TitlesSchema })
  .refine((block) => !('title' in block), 'a template block has titles, not a title');

const TemplateFileSchema = z
  .strictObject({
    key: z.string().regex(TEMPLATE_KEY_PATTERN),
    version: z.int().min(1),
    titles: TitlesSchema,
    scope: DashboardScopeSchema,
    vars: DashboardVarsSchema,
    blocks: z.array(TemplateBlockSchema).max(CAPS.maxBlocks),
    layouts: LayoutsSchema,
  })
  .refine((file) => file.key.endsWith(`@${String(file.version)}`), {
    message: 'the key ends with @<version>',
    path: ['key'],
  });
type TemplateFile = z.infer<typeof TemplateFileSchema>;

/** In gallery order. A malformed file fails at import, loudly (the tests import every one). */
const TEMPLATES: ReadonlyMap<string, TemplateFile> = new Map(
  [dashboard, work, personal, college, collegeCourse, project].map((file) => {
    const parsed = TemplateFileSchema.parse(file);
    return [parsed.key, parsed];
  }),
);

export function listTemplates(): TemplateSummary[] {
  return [...TEMPLATES.values()].map((template) => ({
    key: template.key,
    version: template.version,
    titles: { ...template.titles },
    scope: { ...template.scope },
    blockTypes: template.blocks.map((block) => block['type'] as BlockType),
  }));
}

/**
 * The key of a template: an exact key (`work@1`), or a bare name in any case (`Work`), which
 * means its latest version. Null when there is none.
 */
export function resolveTemplateKey(key: string): string | null {
  if (TEMPLATES.has(key)) return key;
  const name = key.toLowerCase();
  if (name.includes('@')) return TEMPLATES.has(name) ? name : null;
  let latest: TemplateFile | null = null;
  for (const template of TEMPLATES.values()) {
    const [, templateName] = TEMPLATE_KEY_PATTERN.exec(template.key) ?? [];
    if (templateName === name && (latest === null || template.version > latest.version)) {
      latest = template;
    }
  }
  return latest?.key ?? null;
}

/**
 * The template in one language, with its own block ids (`blk_cal`…), as a fresh copy; null for an
 * unknown key. This is what `apply_template` merges in (applyOps assigns the ids).
 */
export function localizeTemplate(key: string, language: TemplateLanguage): DashboardDraft | null {
  const resolved = resolveTemplateKey(key);
  const template = resolved === null ? undefined : TEMPLATES.get(resolved);
  if (template === undefined) return null;
  const copy = structuredClone(template);
  return {
    title: copy.titles[language],
    scope: copy.scope,
    vars: copy.vars,
    layouts: copy.layouts,
    blocks: copy.blocks.map(
      ({ titles, ...block }) => ({ ...block, title: titles[language] }) as Block,
    ),
  };
}

/**
 * A new dashboard draft from a template: titles in `language`, fresh block ids, layouts remapped.
 * Throws OpValidationError (`/templateKey`) for an unknown template.
 */
export function instantiateTemplate(
  key: string,
  { language }: { language: TemplateLanguage },
  nextId: () => string = newBlockId,
): DashboardDraft {
  const localized = localizeTemplate(key, language);
  if (localized === null) throw new OpValidationError('/templateKey', 'no template with this key');
  const used = new Set<string>();
  return remapBlockIds(localized, () => {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = nextId();
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw new Error('nextId keeps returning ids that are taken');
  });
}
