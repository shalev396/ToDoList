/**
 * DocCheck's output, pinned before phase 6b swaps the per-block checks for the Block classes:
 * over every template (both languages) and a set of invalid documents, the issues of `check` (their
 * order, pointers and messages, and whether the document parsed), the lint in each mode (with and
 * without the workspace's topics) and the error `validated` answers (the first issue decides a
 * write's 400). The expected output is docCheck.golden.json, beside this file.
 *
 * A deliberate change of a pointer, message or order regenerates it:
 * `UPDATE_DOCCHECK_GOLDEN=1 node --import tsx --test src/classes/dashboard/docCheck.golden.test.ts`,
 * then review the diff of the JSON.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { OpValidationError } from '../../builder/errors.js';
import { BLOCK_CATALOG } from '../../builder/catalog.js';
import { instantiateTemplate, listTemplates, TEMPLATE_LANGUAGES } from '../../builder/templates.js';
import { CAPS, type Block, type BlockType, type DashboardDraft } from '../../types/builder.js';
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
    issues: check.issues.map(({ pointer, message }) => ({ pointer, message })),
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

interface Snapshot {
  checks: Record<string, CheckOutcome>;
  lints: Record<string, Record<string, Finding[]>>;
}

function snapshot(): Snapshot {
  const checks: Record<string, CheckOutcome> = {};
  const lints: Record<string, Record<string, Finding[]>> = {};
  for (const template of listTemplates()) {
    for (const language of TEMPLATE_LANGUAGES) {
      const name = `template ${template.key} (${language})`;
      const doc = instantiateTemplate(template.key, { language });
      checks[name] = checkOf(doc);
      lints[name] = lintOf(doc);
    }
  }
  for (const [name, input] of Object.entries(INVALID)) checks[name] = checkOf(input);
  for (const [name, doc] of Object.entries(LINT_CASES)) lints[name] = lintOf(doc);
  return { checks, lints };
}

describe('DocCheck: the output phase 6b must keep', () => {
  it('matches docCheck.golden.json: issues, their order, lint per mode, the 400 a write answers', () => {
    const actual = snapshot();
    if (process.env['UPDATE_DOCCHECK_GOLDEN'] === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as unknown;
    assert.deepEqual(actual, golden);
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
});
