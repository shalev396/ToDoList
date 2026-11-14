/**
 * Validation of a whole dashboard draft (BUILDER.md §8, layers 1–3): the schema (with the caps),
 * the catalog (viz per type, a query or a saved view on data blocks) and the compiler (whitelisted
 * fields, operators per field type, literal values), plus two safety rules:
 * - no variable name that reads like a credential or reaches a prototype (`token`, `constructor`);
 * - no secret-shaped text anywhere, so "dashboards never hold secrets" holds by construction and the
 *   response guard never trips on a dashboard.
 *
 * Lint (layer 4: hard-coded text, source links, private fields) is lint.ts. Issues locate the
 * problem with a JSON pointer and never repeat the value.
 */
import { findSecrets } from '../services/secretPatterns.js';
import {
  CAPS,
  DashboardDraftSchema,
  type BlockType,
  type DashboardDraft,
} from '../types/builder.js';
import { checkBlock, isRestrictedName } from './catalog.js';
import { assertSafeInput, compileQuery, type CompileContext } from './compile.js';
import { QueryValidationError, toPointer, zodIssues } from './errors.js';

export interface DraftIssue {
  /** JSON pointer into the draft, e.g. `/blocks/2/viz/kind`. */
  pointer: string;
  message: string;
}

/**
 * The draft as parsed (null when it is not even well-formed: the later layers need that) and
 * every issue found. Valid means no issues.
 */
export interface DraftCheck {
  draft: DashboardDraft | null;
  issues: DraftIssue[];
}

const MAX_ISSUES = 50;

/** Queries compile with fixed inputs: unset `$page` variables drop their rules, the rest is checked. */
const VALIDATION_NOW = new Date('2026-01-01T00:00:00Z');

/** A compile context for checking a query without running it (any caller, no variables). */
export function validationContext(blockType?: BlockType): CompileContext {
  return {
    ws: { id: 'validation' },
    userId: 'validation',
    access: { userId: 'validation', integrations: [], local: 'visible' },
    vars: {},
    now: VALIDATION_NOW,
    timeZone: 'UTC',
    weekStart: 'sun',
    preview: true,
    ...(blockType === undefined ? {} : { blockType }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `$.blocks[0].title` (a findSecrets path) → `/blocks/0/title`. Draft keys are plain names. */
function pathToPointer(path: string): string {
  const tokens = path.slice(1).match(/\.[^.[\]]+|\[\d+\]/g) ?? [];
  return toPointer(
    tokens.map((token) => (token.startsWith('[') ? token.slice(1, -1) : token.slice(1))),
  );
}

function unique(issues: DraftIssue[]): DraftIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (seen.has(issue.pointer)) return false;
    seen.add(issue.pointer);
    return true;
  });
}

/** Catalog and compiler issues of every block, located in the draft. */
function blockIssues(draft: DashboardDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  draft.blocks.forEach((block, index) => {
    const base = `/blocks/${String(index)}`;
    for (const issue of checkBlock(block)) {
      issues.push({ pointer: `${base}${issue.pointer}`, message: issue.message });
    }
    if (block.query === undefined) return;
    try {
      compileQuery(block.query, validationContext(block.type));
    } catch (error) {
      if (!(error instanceof QueryValidationError)) throw error;
      issues.push({ pointer: `${base}/query${error.pointer}`, message: error.reason });
    }
  });
  return issues;
}

/**
 * Checks a draft (stored, sent, or produced by ops): the parsed draft and every issue found (at
 * most 50). Schema issues stop the check: the later layers need a well-formed draft.
 */
export function checkDraft(input: unknown): DraftCheck {
  try {
    assertSafeInput(input);
  } catch (error) {
    if (!(error instanceof QueryValidationError)) throw error;
    return { draft: null, issues: [{ pointer: error.pointer, message: error.reason }] };
  }
  // The block cap first: it reads better than the per-breakpoint layout limits it also breaks.
  if (
    isRecord(input) &&
    Array.isArray(input['blocks']) &&
    input['blocks'].length > CAPS.maxPageBlocks
  ) {
    return {
      draft: null,
      issues: [
        {
          pointer: '/blocks',
          message: `a page holds at most ${String(CAPS.maxPageBlocks)} blocks`,
        },
      ],
    };
  }
  const parsed = DashboardDraftSchema.safeParse(input);
  if (!parsed.success) {
    const issues = zodIssues(parsed.error).map(({ pointer, reason }) => ({
      pointer,
      message: reason,
    }));
    return { draft: null, issues: unique(issues).slice(0, MAX_ISSUES) };
  }
  const draft = parsed.data;
  const issues = blockIssues(draft);
  for (const name of Object.keys(draft.vars)) {
    if (isRestrictedName(name)) {
      issues.push({
        pointer: `/vars${toPointer([name])}`,
        message: 'this variable name is reserved',
      });
    }
  }
  for (const hit of findSecrets(draft)) {
    issues.push({
      pointer: pathToPointer(hit.path),
      message: 'looks like a secret: dashboards never hold secrets',
    });
  }
  return { draft, issues: unique(issues).slice(0, MAX_ISSUES) };
}
