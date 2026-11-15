/**
 * Dashboard lint (BUILDER.md §8, validation layer 4). It runs after validation, on every write:
 * - `hardcoded_text`: any string in a block outside its title and a note block's note that is
 *   not data, structure or a value the catalog allows. A viz option must be one of its enum values
 *   or a catalog field path; anything else (a display-rule badge, a free-string viz option, a
 *   string field added later) must be an i18n key (I18N_KEY_PATTERN). Query and display-rule
 *   conditions hold data (field paths, filter values), not text. Labels, legends and empty states
 *   are computed or come from i18n keys. A warning for people in the UI, an error (which blocks
 *   the write) for agents over MCP.
 * - `source_link_hidden`: a row-rendering block whose viz turns off "Open in <provider>". Always an
 *   error: every item links back to its source.
 * - `private_field`: a field path that reads like a credential, anywhere a block names a field.
 *   Always an error (the compiler's whitelist refuses these too).
 *
 * - `deleted_topic` (H4, a warning in both modes): a rule that names a topic id the workspace no
 *   longer has. It matches nothing, silently, so say so: "This filter names a deleted page".
 *
 * Messages say what is wrong and where (a JSON pointer), never the offending text.
 */
import { z } from 'zod';

import {
  BLOCK_TYPES,
  I18N_KEY_PATTERN,
  VIZ_SCHEMAS,
  type Block,
  type BlockType,
  type DashboardDraft,
  type Rule,
  type RuleGroup,
  VAR_REF_PATTERN,
} from '../types/builder.js';
import { lookupField } from './catalog.js';
import { toPointer } from './errors.js';

export type LintMode = 'ui' | 'mcp';
export type LintSeverity = 'warning' | 'error';
export type LintCode = 'hardcoded_text' | 'source_link_hidden' | 'private_field' | 'deleted_topic';

export interface LintIssue {
  severity: LintSeverity;
  code: LintCode;
  /** JSON pointer into the dashboard, e.g. `/blocks/2/viz/field`. */
  pointer: string;
  message: string;
}

/** What a lint depends on besides the block: the actor's mode, and the workspace's topic ids. */
export interface LintScope {
  mode: LintMode;
  /** Without them the deleted-page check is skipped. */
  topicIds?: ReadonlySet<string> | undefined;
}

/** Blocks that render item or container rows, each with its "Open in <provider>" link. */
const ROW_BLOCKS: ReadonlySet<BlockType> = new Set([
  'list',
  'table',
  'kanban',
  'timeline',
  'agenda',
  'deadlines',
  'calendar',
]);

/** Field paths that read like a credential (BUILDER.md §8, privacy rule). */
const PRIVATE_FIELD = /credential|\benc\b|token|secret|password|api[-_]?key/i;

/** Viz keys whose strings are field paths, checked against the field catalog instead. */
const FIELD_PATH_KEYS: ReadonlySet<string> = new Set(['field', 'columns']);

/** Values of a `*source*` viz key that turn the link off. */
const OFF_VALUES: ReadonlySet<unknown> = new Set([false, 'none', 'hidden', 'hide', 'off']);

type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The values a JSON Schema node allows (`const`, `enum`, or its array items'), or null for any. */
function allowedValues(node: unknown): readonly unknown[] | null {
  if (!isRecord(node)) return null;
  if ('const' in node) return [node['const']];
  if (Array.isArray(node['enum'])) return node['enum'] as unknown[];
  return 'items' in node ? allowedValues(node['items']) : null;
}

/** Per block type and viz key: the strings the catalog allows (null: none, any string is text). */
const VIZ_TEXT: ReadonlyMap<BlockType, ReadonlyMap<string, readonly unknown[] | null>> = new Map(
  BLOCK_TYPES.map((type) => {
    const schema = z.toJSONSchema(VIZ_SCHEMAS[type], { target: 'draft-2020-12' }) as JsonSchema;
    const properties = isRecord(schema['properties']) ? schema['properties'] : {};
    return [
      type,
      new Map(Object.entries(properties).map(([key, node]) => [key, allowedValues(node)])),
    ];
  }),
);

function isCatalogField(path: string): boolean {
  return lookupField('items', path) !== null || lookupField('containers', path) !== null;
}

/** One string somewhere in a block: its path under the block (and that path as a pointer). */
interface BlockString {
  text: string;
  path: string[];
}

/** Every string in a value, with its path: the value itself, or inside lists and objects. */
function strings(value: unknown, path: string[] = [], out: BlockString[] = []): BlockString[] {
  if (typeof value === 'string') out.push({ text: value, path });
  else if (Array.isArray(value)) {
    value.forEach((entry: unknown, index) => strings(entry, [...path, String(index)], out));
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) strings(entry, [...path, key], out);
  }
  return out;
}

/** Block keys holding text the user writes: the only free text a dashboard has (BUILDER §10). */
const FREE_TEXT_KEYS: ReadonlySet<string> = new Set(['title', 'note']);

/** Block keys holding ids, enums and `$page` references, which the schema already constrains. */
const STRUCTURE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'action',
  'savedViewId',
  // A block's sources: integration ids and `local` (PERMISSIONS-V2), never display text.
  'connectors',
  'sets',
  'listen',
  'emits',
]);

/**
 * How a string at `path` (under a block) is judged:
 * - `free`: the title and a note block's note;
 * - `data`: a query, or a display rule's condition (field paths, operators, filter values);
 * - `structure`: ids, enums and variable references (a display rule's tone too);
 * - `viz`: a viz option, checked against the catalog;
 * - `i18n`: anything else, a display-rule badge included: it must be an i18n key.
 */
function textPolicy(path: readonly string[]): 'free' | 'data' | 'structure' | 'viz' | 'i18n' {
  const [top, , part, leaf] = path;
  if (top === undefined) return 'i18n';
  if (FREE_TEXT_KEYS.has(top) && path.length === 1) return 'free';
  if (STRUCTURE_KEYS.has(top)) return 'structure';
  if (top === 'query') return 'data';
  if (top === 'viz') return 'viz';
  if (top === 'rules' && part === 'if') return 'data';
  if (top === 'rules' && part === 'then' && leaf === 'tone') return 'structure';
  return 'i18n';
}

class Linter {
  readonly issues: LintIssue[] = [];

  private readonly mode: LintMode;
  private readonly topicIds: ReadonlySet<string> | undefined;

  constructor(mode: LintMode, topicIds?: ReadonlySet<string>) {
    this.mode = mode;
    this.topicIds = topicIds;
  }

  private add(code: LintCode, severity: LintSeverity, pointer: string, message: string): void {
    this.issues.push({ code, severity, pointer, message });
  }

  /** A `topic` rule with a literal id the workspace no longer has (a `$page.` variable is not one). */
  private topicRule(rule: Rule, pointer: string): void {
    if (this.topicIds === undefined || rule.field !== 'topic') return;
    const values = Array.isArray(rule.value) ? rule.value : [rule.value];
    const missing = values.some(
      (value) =>
        typeof value === 'string' &&
        value !== '' &&
        !VAR_REF_PATTERN.test(value) &&
        this.topicIds?.has(value) === false,
    );
    if (missing) {
      this.add(
        'deleted_topic',
        'warning',
        `${pointer}/value`,
        'This filter names a deleted page: it matches nothing',
      );
    }
  }

  /** `field` is a field path: report it when it reads like a credential. */
  private field(path: string, pointer: string): void {
    if (PRIVATE_FIELD.test(path)) {
      this.add('private_field', 'error', pointer, 'a field that may hold a credential');
    }
  }

  private group(group: RuleGroup, pointer: string): void {
    group.rules.forEach((node, index) => {
      const nodePointer = `${pointer}/rules/${String(index)}`;
      if ('combinator' in node) this.group(node, nodePointer);
      else {
        this.field(node.field, `${nodePointer}/field`);
        this.topicRule(node, nodePointer);
      }
    });
  }

  fields(block: Block, base: string): void {
    const { query } = block;
    if (query !== undefined) {
      if (query.where !== undefined) this.group(query.where, `${base}/query/where`);
      query.sort?.forEach((entry, index) => {
        this.field(entry.field, `${base}/query/sort/${String(index)}/field`);
      });
      query.groupBy?.forEach((path, index) => {
        this.field(path, `${base}/query/groupBy/${String(index)}`);
      });
      if (query.aggregate?.field !== undefined) {
        this.field(query.aggregate.field, `${base}/query/aggregate/field`);
      }
    }
    block.rules?.forEach((rule, index) => {
      this.field(rule.if.field, `${base}/rules/${String(index)}/if/field`);
      this.topicRule(rule.if, `${base}/rules/${String(index)}/if`);
    });
  }

  private hardcoded(pointer: string): void {
    this.add(
      'hardcoded_text',
      this.mode === 'ui' ? 'warning' : 'error',
      pointer,
      'hard-coded text: labels come from data or i18n keys; only titles and notes hold text',
    );
  }

  /**
   * A viz option: one of its enum values (whatever its shape), a catalog field path for the
   * field-path options (credential-shaped ones are private_field), or else an i18n key.
   */
  private vizString(type: BlockType, key: string, text: string, pointer: string): void {
    const values = VIZ_TEXT.get(type)?.get(key) ?? null;
    if (values !== null) {
      if (!values.includes(text)) this.hardcoded(pointer);
      return;
    }
    if (FIELD_PATH_KEYS.has(key)) {
      if (PRIVATE_FIELD.test(text)) this.field(text, pointer);
      else if (!isCatalogField(text)) this.hardcoded(pointer);
      return;
    }
    if (!I18N_KEY_PATTERN.test(text)) this.hardcoded(pointer);
  }

  /** Every string in the block, judged by where it sits (textPolicy). */
  text(block: Block, base: string): void {
    for (const { text, path } of strings(block)) {
      const pointer = `${base}${toPointer(path)}`;
      switch (textPolicy(path)) {
        case 'free':
        case 'data':
        case 'structure':
          break;
        case 'viz':
          this.vizString(block.type, path[1] ?? '', text, pointer);
          break;
        case 'i18n':
          if (!I18N_KEY_PATTERN.test(text)) this.hardcoded(pointer);
          break;
      }
    }
  }

  block(block: Block, index: number): void {
    const base = `/blocks/${String(index)}`;
    this.fields(block, base);
    if (ROW_BLOCKS.has(block.type)) {
      for (const found of lintSourceLink(block)) {
        this.issues.push({ ...found, pointer: `${base}${found.pointer}` });
      }
    }
    this.text(block, base);
  }
}

/*
 * One block's lint, rule by rule, its pointers relative to the block. The Block classes
 * (classes/dashboard/blocks/) run them in this order: fields, then the source link of a block that
 * renders rows, then text.
 */

/**
 * `private_field` for every field path the block's query and display rules name; with the
 * workspace's topic ids, `deleted_topic` for a topic rule that names a topic it no longer has.
 */
export function lintFields(block: Block, scope: LintScope): LintIssue[] {
  const linter = new Linter(scope.mode, scope.topicIds);
  linter.fields(block, '');
  return linter.issues;
}

/**
 * `source_link_hidden`, an error in every mode: a viz option that turns "Open in <provider>" off.
 * Only for a block that renders rows (its class knows).
 */
export function lintSourceLink(block: Block): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const [key, value] of Object.entries(block.viz)) {
    if (!/source/i.test(key)) continue;
    const hides = OFF_VALUES.has(value) || (value === true && /hide/i.test(key));
    if (hides) {
      issues.push({
        code: 'source_link_hidden',
        severity: 'error',
        pointer: `/viz${toPointer([key])}`,
        message: 'rows always link to their source: this block cannot turn that off',
      });
    }
  }
  return issues;
}

/**
 * `hardcoded_text` (a warning in the UI, an error for agents) for every string outside the title
 * and a note's note that is not data, structure or a value the catalog allows; `private_field` for
 * a credential-shaped viz field path.
 */
export function lintText(block: Block, scope: LintScope): LintIssue[] {
  const linter = new Linter(scope.mode, scope.topicIds);
  linter.text(block, '');
  return linter.issues;
}

/**
 * Lint issues of a (schema-valid) draft, in block order. Errors block the write. `topicIds`: the
 * workspace's topic ids; without them the deleted-page check is skipped.
 */
export function lintDashboard(
  draft: DashboardDraft,
  mode: LintMode,
  topicIds?: ReadonlySet<string>,
): LintIssue[] {
  const linter = new Linter(mode, topicIds);
  draft.blocks.forEach((block, index) => {
    linter.block(block, index);
  });
  return linter.issues;
}
