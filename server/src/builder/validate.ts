/**
 * The document-level steps of a dashboard draft's validation (BUILDER.md §8, layers 1–3), pure.
 * DocCheck (classes/dashboard/DocCheck.ts) composes them around the per-block check of the Block
 * classes (the catalog and the compiler, block by block), in this order:
 * 1. `refusedInput`, before any parsing: no `$`-key and no nesting too deep anywhere, then the
 *    block cap; either stops the check;
 * 2. `parseDraft`: the schema (with the caps); its issues stop the check;
 * 3. the blocks (Block#check);
 * 4. `variableIssues`: no variable name that reads like a credential or reaches a prototype
 *    (`token`, `constructor`);
 * 5. `secretIssues`: no secret-shaped text anywhere, so "dashboards never hold secrets" holds by
 *    construction and the response guard never trips on a dashboard;
 * 6. `finalIssues`: one issue per pointer, at most 50.
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
import { isRestrictedName } from './catalog.js';
import { assertSafeInput, type CompileContext } from './compile.js';
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

function unique(issues: readonly DraftIssue[]): DraftIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (seen.has(issue.pointer)) return false;
    seen.add(issue.pointer);
    return true;
  });
}

/**
 * The input refused before any parsing (null: go on): a `$`-key or nesting too deep anywhere, then
 * more blocks than a page holds.
 */
export function refusedInput(input: unknown): DraftIssue | null {
  try {
    assertSafeInput(input);
  } catch (error) {
    if (!(error instanceof QueryValidationError)) throw error;
    return { pointer: error.pointer, message: error.reason };
  }
  // The block cap first: it reads better than the per-breakpoint layout limits it also breaks.
  if (
    isRecord(input) &&
    Array.isArray(input['blocks']) &&
    input['blocks'].length > CAPS.maxPageBlocks
  ) {
    return {
      pointer: '/blocks',
      message: `a page holds at most ${String(CAPS.maxPageBlocks)} blocks`,
    };
  }
  return null;
}

/**
 * The draft parsed by the schema (no issues), or null with the schema's issues (one per pointer, at
 * most 50): they stop the check, as the later steps need a well-formed draft.
 */
export function parseDraft(input: unknown): DraftCheck {
  const parsed = DashboardDraftSchema.safeParse(input);
  if (parsed.success) return { draft: parsed.data, issues: [] };
  const issues = zodIssues(parsed.error).map(({ pointer, reason }) => ({
    pointer,
    message: reason,
  }));
  return { draft: null, issues: finalIssues(issues) };
}

/** Variable names that are reserved (they read like a credential or reach a prototype). */
export function variableIssues(draft: DashboardDraft): DraftIssue[] {
  return Object.keys(draft.vars)
    .filter((name) => isRestrictedName(name))
    .map((name) => ({
      pointer: `/vars${toPointer([name])}`,
      message: 'this variable name is reserved',
    }));
}

/** Every string anywhere in the draft that looks like a secret. */
export function secretIssues(draft: DashboardDraft): DraftIssue[] {
  return findSecrets(draft).map((hit) => ({
    pointer: pathToPointer(hit.path),
    message: 'looks like a secret: dashboards never hold secrets',
  }));
}

/** The issues as a check answers them: the first one per pointer, at most 50. */
export function finalIssues(issues: readonly DraftIssue[]): DraftIssue[] {
  return unique(issues).slice(0, MAX_ISSUES);
}
