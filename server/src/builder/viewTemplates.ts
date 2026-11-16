/**
 * View templates (H3, D3): data, not code, like the dashboard templates. Each JSON file in
 * `templates/views/` is one page view with its titles in English and Hebrew: a rigid view (one
 * block, no layouts) or a dashboard view (its blocks and layouts). Their queries filter by
 * `$page.topic` (a page of a topic sets it), and their provider hints bind to the instantiating
 * member's own integrations like any template's (connectors.ts).
 */
import { z } from 'zod';

import {
  CAPS,
  DashboardVarsSchema,
  LayoutsSchema,
  VIEW_BLOCK_TYPE,
  VIEW_TYPES,
  isRigidViewType,
  type Block,
} from '../types/builder.js';
import type { ViewTemplateSummary } from '../types/dashboards.js';
import type { ViewTemplateDraft } from './ops.js';
import byStatus from './templates/views/by-status.json' with { type: 'json' };
import deadlinesAgenda from './templates/views/deadlines-agenda.json' with { type: 'json' };
import myOpenWork from './templates/views/my-open-work.json' with { type: 'json' };
import studyDashboard from './templates/views/study-dashboard.json' with { type: 'json' };
import thisWeek from './templates/views/this-week.json' with { type: 'json' };
import workloadThisWeek from './templates/views/workload-this-week.json' with { type: 'json' };
import type { TemplateLanguage } from './templates.js';

const TitlesSchema = z.strictObject({
  en: z.string().min(1).max(80),
  he: z.string().min(1).max(80),
});

const VIEW_TEMPLATE_KEY_PATTERN = /^([a-z][a-z0-9-]*)@([1-9][0-9]*)$/;

const ViewTemplateFileSchema = z
  .strictObject({
    key: z.string().regex(VIEW_TEMPLATE_KEY_PATTERN),
    version: z.int().min(1),
    titles: TitlesSchema,
    type: z.enum(VIEW_TYPES),
    vars: DashboardVarsSchema,
    blocks: z
      .array(
        z
          .looseObject({ titles: TitlesSchema })
          .refine((block) => !('title' in block), 'a template block has titles, not a title'),
      )
      .min(1)
      .max(CAPS.maxBlocks),
    layouts: LayoutsSchema,
  })
  .refine((file) => file.key.endsWith(`@${String(file.version)}`), {
    message: 'the key ends with @<version>',
    path: ['key'],
  })
  .refine(
    (file) =>
      isRigidViewType(file.type)
        ? file.blocks.length === 1 && file.blocks[0]?.['type'] === VIEW_BLOCK_TYPE[file.type]
        : true,
    { message: 'a rigid view template holds exactly one block of its type', path: ['blocks'] },
  );
type ViewTemplateFile = z.infer<typeof ViewTemplateFileSchema>;

/** In gallery order. A malformed file fails at import, loudly (the tests import every one). */
const VIEW_TEMPLATES: ReadonlyMap<string, ViewTemplateFile> = new Map(
  [myOpenWork, byStatus, thisWeek, deadlinesAgenda, workloadThisWeek, studyDashboard].map(
    (file) => {
      const parsed = ViewTemplateFileSchema.parse(file);
      return [parsed.key, parsed];
    },
  ),
);

export function listViewTemplates(): ViewTemplateSummary[] {
  return [...VIEW_TEMPLATES.values()].map((template) => ({
    key: template.key,
    version: template.version,
    titles: { ...template.titles },
    type: template.type,
    blockTypes: template.blocks.map((block) => block['type'] as Block['type']),
  }));
}

/** An exact key (`this-week@1`), or a bare name (its latest version); null when there is none. */
export function resolveViewTemplateKey(key: string): string | null {
  const name = key.toLowerCase();
  if (VIEW_TEMPLATES.has(name)) return name;
  if (name.includes('@')) return null;
  let latest: ViewTemplateFile | null = null;
  for (const template of VIEW_TEMPLATES.values()) {
    const [, templateName] = VIEW_TEMPLATE_KEY_PATTERN.exec(template.key) ?? [];
    if (templateName === name && (latest === null || template.version > latest.version)) {
      latest = template;
    }
  }
  return latest?.key ?? null;
}

/** The template in one language, as a fresh copy (its block ids are replaced by add_view). */
export function localizeViewTemplate(
  key: string,
  language: TemplateLanguage,
): ViewTemplateDraft | null {
  const resolved = resolveViewTemplateKey(key);
  const template = resolved === null ? undefined : VIEW_TEMPLATES.get(resolved);
  if (template === undefined) return null;
  const copy = structuredClone(template);
  return {
    key: copy.key,
    type: copy.type,
    title: copy.titles[language],
    vars: copy.vars,
    layouts: copy.layouts,
    blocks: copy.blocks.map(
      ({ titles, ...block }) => ({ ...block, title: titles[language] }) as Block,
    ),
  };
}
