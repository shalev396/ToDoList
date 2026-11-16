/**
 * DocCheck's output, pinned before phase 6b swapped the per-block checks for the Block classes and
 * unchanged by the swap, over every template (both languages), every block type (valid, and
 * failing each catalog rule) and a set of invalid documents:
 * - the issues of `check` as it returns them (their order, pointers and messages, their keys and
 *   the keys' order, and whether the document parsed), the depth refusal and the 50-issue cap
 *   included;
 * - the lint in each mode (with and without the workspace's topics);
 * - the error `validated` answers in each mode (the first issue, else the first lint error, decides
 *   a write's 400: ui and mcp differ on hard-coded text);
 * - what `validation` (builder_validate) and `restorable` (undo, redo, revert: a person's and an
 *   agent's) answer;
 * - what the ops write path (applyOps) refuses.
 * The expected output is docCheck.golden.json, beside this file.
 *
 * A deliberate change of a pointer, message or order regenerates it:
 * `UPDATE_DOCCHECK_GOLDEN=1 node --import tsx --test src/classes/dashboard/docCheck.golden.test.ts`,
 * then review the diff of the JSON (the commit hook formats it with Prettier).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { OpValidationError } from '../../builder/errors.js';
import { BLOCK_CATALOG } from '../../builder/catalog.js';
import { applyOps, type ApplyOpsContext } from '../../builder/ops.js';
import { instantiateTemplate, listTemplates, TEMPLATE_LANGUAGES } from '../../builder/templates.js';
import { AppError } from '../../errors/AppError.js';
import {
  BLOCK_TYPES,
  CAPS,
  type Block,
  type BlockType,
  type DashboardDraft,
} from '../../types/builder.js';
import type { DashboardValidation } from '../../types/dashboards.js';
import { DocCheck } from './DocCheck.js';

const GOLDEN = new URL('./docCheck.golden.json', import.meta.url);

/** A topic id a block may name; anything else reads as a deleted page. */
const TOPIC_IDS: ReadonlySet<string> = new Set(['t-live']);

const SCOPE = { topicId: null, containerId: null, page: 'topic', groupVar: null };
const LAYOUTS = { lg: [], md: [], sm: [] };

/** A schema-valid block of `type` with the catalog's defaults, as the builder's tests make one. */
function blockOf(type: BlockType, index: number, extra: Record<string, unknown> = {}): Block {
  return {
    id: `blk_${type}_${String(index)}`,
    type,
    title: 'Any title',
    ...BLOCK_CATALOG[type].defaults,
    ...extra,
  } as Block;
}

function documentOf(blocks: unknown[], vars: Record<string, unknown> = {}): DashboardDraft {
  return { title: 'Page', scope: SCOPE, vars, layouts: LAYOUTS, blocks } as DashboardDraft;
}

/** A query whose rule names a field outside the whitelist (a compile issue under `/query`). */
const UNKNOWN_FIELD_QUERY = {
  source: 'items',
  where: { combinator: 'and', rules: [{ field: 'nope.field', operator: '=', value: 1 }] },
};

/** `depth` objects inside one another. */
function nested(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < depth; level += 1) value = { inner: value };
  return value;
}

/** One block of every type, each made by `make` (catalog defaults otherwise). */
function everyType(make: (type: BlockType) => Record<string, unknown> = () => ({})): Block[] {
  return BLOCK_TYPES.map((type, index) => blockOf(type, index, make(type)));
}

/** Passes `check`; lints to hard-coded text (a badge), then a private field (a table column). */
const LINT_FAILING = documentOf([
  blockOf('list', 1, {
    rules: [{ if: { field: 'status', operator: '=', value: 'open' }, then: { badge: 'Late!' } }],
  }),
  blockOf('table', 2, { viz: { kind: 'table', columns: ['title', 'props.apiKey'] } }),
]);

/** Passes `check`; lints to hard-coded text only (a warning for people, an error for agents). */
const HARDCODED_ONLY = documentOf([
  blockOf('kanban', 1, {
    rules: [{ if: { field: 'status', operator: '=', value: 'open' }, then: { badge: 'Soon' } }],
  }),
]);

/**
 * A row block whose viz turns its source link off and holds hard-coded text: its lint says the
 * source link first, then the text (Block#lint: `lintSpecific()` before `lintText()`), which is
 * the order a builder_validate answer lists them in (phase 6b review M1). The list's viz schema
 * refuses both keys, so the check has an issue too.
 */
const SOURCE_LINK_AND_TEXT = documentOf([
  blockOf('list', 1, { viz: { kind: 'list', showSource: false, caption: 'Hello' } }),
]);

/** Documents each failing a different step of `check`, several steps at once where order matters. */
const INVALID: Readonly<Record<string, unknown>> = {
  'a $ key anywhere': documentOf([], { $where: 1 }),
  'more blocks than a page holds': documentOf(
    Array.from({ length: CAPS.maxPageBlocks + 1 }, (_, index) => blockOf('note', index)),
  ),
  'schema issues, several': {
    scope: { ...SCOPE, page: 'nowhere' },
    vars: { range: 5 },
    layouts: { lg: [] },
    blocks: [{ id: 'b1', type: 'no-such-type' }],
  },
  'catalog, query, variable and secret issues together': documentOf(
    [
      blockOf('list', 1, { viz: { kind: 'kanban' } }),
      blockOf('list', 2, {
        query: {
          source: 'items',
          where: { combinator: 'and', rules: [{ field: 'nope.field', operator: '=', value: 1 }] },
        },
      }),
      blockOf('counter', 3, { query: undefined }),
      blockOf('note', 4, { note: 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123' }),
    ],
    { enc: null },
  ),
  'every block type, catalog defaults': documentOf(everyType()),
  'every block type, a viz kind it does not render': documentOf(
    everyType(() => ({ viz: { kind: 'nope' } })),
  ),
  'every block type, the query rule broken': documentOf(
    everyType((type) =>
      BLOCK_CATALOG[type].requiredQuery
        ? { query: undefined }
        : { query: { source: 'items', limit: 5 } },
    ),
  ),
  'every data block type, a saved view instead of a query': documentOf(
    everyType((type) =>
      BLOCK_CATALOG[type].requiredQuery ? { query: undefined, savedViewId: 'view-1' } : {},
    ),
  ),
  'every block type, a query outside the whitelist': documentOf(
    everyType(() => ({ query: UNKNOWN_FIELD_QUERY })),
  ),
  'control blocks without their control': documentOf([
    blockOf('filter', 1, { sets: undefined }),
    blockOf('action', 2, { action: undefined }),
  ]),
  'catalog and query issues in one block': documentOf([
    blockOf('list', 1, { viz: { kind: 'kanban' }, query: UNKNOWN_FIELD_QUERY }),
    blockOf('filter', 2, { sets: undefined, query: UNKNOWN_FIELD_QUERY }),
    blockOf('action', 3, {
      viz: { kind: 'link' },
      action: undefined,
      query: UNKNOWN_FIELD_QUERY,
    }),
    blockOf('chart', 4, { viz: { kind: 'pie', extra: 1 }, query: undefined }),
  ]),
  'nested too deep': documentOf([], { deep: nested(40) }),
  'more than 50 block issues': documentOf(
    Array.from({ length: 20 }, (_, index) =>
      blockOf('note', index, { viz: { kind: 'nope', extra: 1 }, query: UNKNOWN_FIELD_QUERY }),
    ),
  ),
  'more than 50 schema issues': documentOf(
    Array.from({ length: 60 }, (_, index) => ({ ...blockOf('note', index), id: 'bad' })),
  ),
  'passes the check, fails the lint': LINT_FAILING,
  'passes the check, hard-coded text only': HARDCODED_ONLY,
  'a row block with its source link off and hard-coded text': SOURCE_LINK_AND_TEXT,
};

/** Documents for the lint alone (each rule, both severities), linted as they are. */
const LINT_CASES: Readonly<Record<string, DashboardDraft>> = {
  'every lint rule': documentOf([
    blockOf('filter', 1, { viz: { kind: 'chips', field: 'Pick a project' } }),
    blockOf('list', 2, {
      viz: { kind: 'list', showSource: false },
      query: {
        source: 'items',
        where: {
          combinator: 'and',
          rules: [
            { field: 'topic', operator: '=', value: 't-gone' },
            { field: 'topic', operator: '=', value: 't-live' },
            { field: 'props.apiKey', operator: 'notNull' },
          ],
        },
      },
    }),
    blockOf('chart', 3, { viz: { kind: 'donut', emptyText: 'Nothing open' } }),
  ]),
  'every block type, catalog defaults': documentOf(everyType()),
  'every block type, the source link turned off': documentOf(
    everyType((type) => ({ viz: { ...BLOCK_CATALOG[type].defaults.viz, showSource: false } })),
  ),
  'every block type, a viz kind it does not render': documentOf(
    everyType(() => ({ viz: { kind: 'nope' } })),
  ),
  'every block type, a free-text viz option and a private field': documentOf(
    everyType((type) => ({
      viz: { ...BLOCK_CATALOG[type].defaults.viz, caption: 'Hello', field: 'props.secretKey' },
    })),
  ),
  'passes the check, fails the lint': LINT_FAILING,
  'passes the check, hard-coded text only': HARDCODED_ONLY,
  'a row block with its source link off and hard-coded text': SOURCE_LINK_AND_TEXT,
};

/** Ops applied to a small page, each refused or written by the ops write path. */
const OPS_CASES: Readonly<Record<string, unknown[]>> = {
  'add a block the catalog allows': [{ op: 'add_block', block: { type: 'deadlines' } }],
  'add a block with a viz its type does not render': [
    { op: 'add_block', block: { type: 'chart', viz: { kind: 'kanban' } } },
  ],
  'add a block whose query leaves the whitelist': [
    { op: 'add_block', block: { type: 'list', query: UNKNOWN_FIELD_QUERY } },
  ],
  'update a block to hold a secret': [
    {
      op: 'update_block',
      blockId: 'blk_note_1',
      patch: { note: 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123' },
    },
  ],
  'a filter viz the catalog refuses': [
    { op: 'update_block', blockId: 'blk_filter_2', patch: { viz: { kind: 'chips', multi: 3 } } },
  ],
  'an op the schema refuses, after one that applies': [
    { op: 'add_block', block: { type: 'counter' } },
    { op: 'add_block', block: { type: 'counter', query: { source: 'items', limit: 0 } } },
  ],
};

interface Finding {
  severity: string;
  code: string;
  pointer: string;
  message: string;
}

interface CheckOutcome {
  parsed: boolean;
  issues: { pointer: string; message: string }[];
  /** The 400 a write answers in each mode, or null when it would be written. */
  validated: Record<string, { pointer: string; message: string } | null>;
}

function validatedIn(
  input: unknown,
  mode: 'ui' | 'mcp',
): { pointer: string; message: string } | null {
  try {
    DocCheck.instance.validated(input, mode);
    return null;
  } catch (error) {
    if (!(error instanceof OpValidationError)) throw error;
    return { pointer: error.pointer, message: error.reason };
  }
}

function checkOf(input: unknown): CheckOutcome {
  const check = DocCheck.instance.check(input);
  return {
    parsed: check.draft !== null,
    // As returned: a class that adds a key to an issue, or reorders its keys, changes the golden.
    issues: check.issues,
    validated: { ui: validatedIn(input, 'ui'), mcp: validatedIn(input, 'mcp') },
  };
}

/** The lint in each mode, and with the workspace's topics (the deleted-page rule). */
function lintOf(doc: DashboardDraft): Record<string, Finding[]> {
  return {
    ui: DocCheck.instance.lint(doc, 'ui'),
    mcp: DocCheck.instance.lint(doc, 'mcp'),
    'ui with topics': DocCheck.instance.lint(doc, 'ui', TOPIC_IDS),
  };
}

/** builder_validate's answer in each mode, with the workspace's topics. */
function validationOf(input: unknown): Record<string, DashboardValidation> {
  return {
    ui: DocCheck.instance.validation(input, 'ui', TOPIC_IDS),
    mcp: DocCheck.instance.validation(input, 'mcp', TOPIC_IDS),
  };
}

/** An error as a client sees it: the status, the message, and the pointer of a 400. */
interface Refusal {
  status: number;
  message: string;
  pointer?: string;
}

function refusalOf(error: unknown): Refusal {
  if (error instanceof OpValidationError) {
    return { status: error.statusCode, message: error.message, pointer: error.pointer };
  }
  if (error instanceof AppError) return { status: error.statusCode, message: error.message };
  throw error;
}

/** A restore (undo) of `state` by a person and by an agent: null when it is restored. */
function restoreOf(state: unknown): Record<string, Refusal | null> {
  const outcome = (byAgent: boolean): Refusal | null => {
    try {
      DocCheck.instance.restorable(state as DashboardDraft, 'undo', byAgent);
      return null;
    } catch (error) {
      return refusalOf(error);
    }
  };
  return { person: outcome(false), agent: outcome(true) };
}

/** The page the ops cases edit: a note and a filter. */
const OPS_PAGE = documentOf([blockOf('note', 1), blockOf('filter', 2)]);

function opsContext(): ApplyOpsContext {
  let next = 0;
  return {
    // The ops write path checks its result through DocCheck, as Dashboard#applyOps wires it (R1).
    check: (draft) => DocCheck.instance.check(draft),
    newBlockId: (): string => {
      next += 1;
      return `blk_golden_${String(next)}`;
    },
    templates: () => null,
  };
}

/** What the ops write path answers: the blocks it would write, or its refusal. */
function opsOf(ops: unknown[]): { blocks: string[] } | Refusal {
  try {
    const result = applyOps(OPS_PAGE, ops as Parameters<typeof applyOps>[1], opsContext());
    return { blocks: result.next.blocks.map((block) => `${block.id} ${block.type}`) };
  } catch (error) {
    return refusalOf(error);
  }
}

interface Snapshot {
  checks: Record<string, CheckOutcome>;
  lints: Record<string, Record<string, Finding[]>>;
  validations: Record<string, Record<string, DashboardValidation>>;
  restores: Record<string, Record<string, Refusal | null>>;
  ops: Record<string, { blocks: string[] } | Refusal>;
}

function snapshot(): Snapshot {
  const checks: Record<string, CheckOutcome> = {};
  const lints: Record<string, Record<string, Finding[]>> = {};
  const validations: Record<string, Record<string, DashboardValidation>> = {};
  const restores: Record<string, Record<string, Refusal | null>> = {};
  const ops: Record<string, { blocks: string[] } | Refusal> = {};
  for (const template of listTemplates()) {
    for (const language of TEMPLATE_LANGUAGES) {
      const name = `template ${template.key} (${language})`;
      const doc = instantiateTemplate(template.key, { language });
      checks[name] = checkOf(doc);
      lints[name] = lintOf(doc);
      validations[name] = validationOf(doc);
      restores[name] = restoreOf(doc);
    }
  }
  for (const [name, input] of Object.entries(INVALID)) {
    checks[name] = checkOf(input);
    validations[name] = validationOf(input);
    restores[name] = restoreOf(input);
  }
  for (const [name, doc] of Object.entries(LINT_CASES)) {
    lints[name] = lintOf(doc);
    validations[`lint: ${name}`] = validationOf(doc);
  }
  for (const [name, list] of Object.entries(OPS_CASES)) ops[name] = opsOf(list);
  return { checks, lints, validations, restores, ops };
}

describe('DocCheck: the output phase 6b kept', () => {
  it('matches docCheck.golden.json: issues, their order, lint per mode, the 400 a write answers', () => {
    const actual = snapshot();
    if (process.env['UPDATE_DOCCHECK_GOLDEN'] === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as unknown;
    assert.deepEqual(actual, golden);
    // Byte for byte as a response serializes it: the keys of every issue in the same order too.
    assert.equal(JSON.stringify(actual), JSON.stringify(golden));
  });

  it('exercises every step and lint rule (the golden is not vacuous)', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Snapshot;
    const checks = Object.entries(golden.checks);
    const messages = checks.flatMap(([, outcome]) => outcome.issues.map((found) => found.message));
    const pointers = checks.flatMap(([, outcome]) => outcome.issues.map((found) => found.pointer));
    const findings = Object.values(golden.lints).flatMap((byMode) => Object.values(byMode).flat());
    assert.ok(
      messages.some((message) => message.startsWith('keys starting with')),
      'a $ key',
    );
    assert.ok(
      messages.some((message) => message.includes('at most')),
      'the block cap',
    );
    assert.ok(
      checks.some(([, outcome]) => !outcome.parsed && outcome.issues.length > 1),
      'several schema issues',
    );
    assert.ok(
      pointers.some((pointer) => /^\/blocks\/\d+\/viz/.test(pointer)),
      'a catalog issue',
    );
    assert.ok(
      pointers.some((pointer) => /^\/blocks\/\d+\/query/.test(pointer)),
      'a query issue',
    );
    assert.ok(
      pointers.some((pointer) => pointer.startsWith('/vars/')),
      'a reserved variable',
    );
    assert.ok(
      messages.some((message) => message.includes('secret')),
      'the secret scan',
    );
    for (const code of ['hardcoded_text', 'source_link_hidden', 'private_field', 'deleted_topic']) {
      assert.ok(
        findings.some((found) => found.code === code),
        code,
      );
    }
    assert.ok(new Set(findings.map((found) => found.severity)).size === 2, 'warnings and errors');
    assert.ok(
      checks.some(([name, outcome]) => name.startsWith('template ') && outcome.issues.length === 0),
      'the templates pass the check',
    );
  });

  it('pins every block type, the write policy and the limits (R2)', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Snapshot;
    const pointersOf = (name: string): string[] =>
      (golden.checks[name]?.issues ?? []).map((found) => found.pointer);
    assert.deepEqual(golden.checks['every block type, catalog defaults']?.issues, []);
    assert.deepEqual(
      golden.checks['every data block type, a saved view instead of a query']?.issues,
      [],
    );
    for (const name of [
      'every block type, a viz kind it does not render',
      'every block type, the query rule broken',
      'every block type, a query outside the whitelist',
    ]) {
      const blocks = new Set(pointersOf(name).map((pointer) => pointer.split('/')[2]));
      assert.equal(blocks.size, BLOCK_TYPES.length, name);
    }
    const lintPointers = (name: string): string[] =>
      Object.values(golden.lints[name] ?? {})
        .flat()
        .map((found) => found.pointer);
    for (const name of [
      'every block type, a viz kind it does not render',
      'every block type, a free-text viz option and a private field',
    ]) {
      const blocks = new Set(lintPointers(name).map((pointer) => pointer.split('/')[2]));
      assert.equal(blocks.size, BLOCK_TYPES.length, name);
    }
    const sourceLinks = golden.lints['every block type, the source link turned off']?.['ui'] ?? [];
    assert.ok(sourceLinks.filter((found) => found.code === 'source_link_hidden').length >= 7);
    // One block's own lint order: its source link, then its text (M1).
    const both = 'a row block with its source link off and hard-coded text';
    assert.deepEqual(
      (golden.lints[both]?.['mcp'] ?? []).map((found) => found.code),
      ['source_link_hidden', 'hardcoded_text'],
    );
    assert.deepEqual(
      (golden.validations[`lint: ${both}`]?.['mcp']?.errors ?? []).map((found) => found.pointer),
      ['/blocks/0/viz', '/blocks/0/viz/showSource', '/blocks/0/viz/caption'],
    );
    // The same block with a catalog issue and a query issue, and a control's own rule in between.
    const sameBlock = pointersOf('catalog and query issues in one block');
    assert.ok(
      sameBlock.includes('/blocks/0/viz/kind') &&
        sameBlock.some((p) => p.startsWith('/blocks/0/query/')),
    );
    assert.ok(
      sameBlock.includes('/blocks/1/sets') &&
        sameBlock.some((p) => p.startsWith('/blocks/1/query/')),
    );
    // The write policy: passes the check, then the first lint error decides, per mode.
    const failing = golden.checks['passes the check, fails the lint'];
    assert.ok(failing !== undefined);
    assert.deepEqual(failing.issues, []);
    assert.notDeepEqual(failing.validated['ui'], failing.validated['mcp']);
    const hardcoded = golden.checks['passes the check, hard-coded text only'];
    assert.ok(hardcoded !== undefined);
    assert.equal(hardcoded.validated['ui'], null);
    assert.notEqual(hardcoded.validated['mcp'], null);
    // The limits.
    assert.ok(
      Object.values(golden.checks).some((outcome) =>
        outcome.issues.some((found) => found.message === 'nested too deep'),
      ),
    );
    assert.equal(golden.checks['more than 50 block issues']?.issues.length, 50);
    assert.equal(golden.checks['more than 50 schema issues']?.issues.length, 50);
    // validation, restorable and the ops path.
    const validations = Object.values(golden.validations).flatMap((byMode) =>
      Object.values(byMode),
    );
    assert.ok(
      validations.some((found) => found.valid) && validations.some((found) => !found.valid),
    );
    assert.ok(validations.some((found) => found.warnings.length > 0));
    const restores = Object.values(golden.restores).flatMap((byActor) => Object.values(byActor));
    for (const status of [409, 400]) {
      assert.ok(
        restores.some((found) => found?.status === status),
        String(status),
      );
    }
    assert.ok(restores.includes(null));
    const ops = Object.values(golden.ops);
    assert.ok(ops.some((found) => 'blocks' in found) && ops.some((found) => 'status' in found));
  });
});
