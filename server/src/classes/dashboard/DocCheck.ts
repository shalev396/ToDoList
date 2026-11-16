/**
 * The one place a dashboard document is checked and linted (BUILDER.md §6–§8). It also owns the
 * policy of what a finding means: the first error of a write is its 400, and a restore that no
 * longer passes is a 409. Who comes here:
 * - writes: `save` and `applyPatch` (`validated`), builder ops, REST and MCP, the persona's views
 *   and the seed's blocks included (Dashboard#applyOps hands `check` to the builder's applyOps as
 *   `ApplyOpsContext.check`, so the ops path has no check of its own), creating and instantiating
 *   (NewDashboard: `validated`);
 * - dry runs: of ops (the same `check`), of a patch, undo and revert (DashboardDryRun);
 * - restores: undo, redo, revert (`restorable`);
 * - `validation` (`POST …/builder/validate`, builder_validate).
 * The one write that is not checked again is "Stop sharing" (Dashboard#stripConnector): it only
 * takes one connector off a stored draft, which passed this check when it was written.
 *
 * What is checked, and at which level (docCheck.golden.test.ts pins the output: order, pointers,
 * messages, key order). The document-level steps are the builder's pure ones (validate.ts); the
 * per-block steps are the Block classes' (`Block.from(json)`, classes/dashboard/blocks/), each
 * block's pointers put under `/blocks/<i>`.
 *
 * `check` (validation layers 1–3). Issues come in this order, deduplicated by pointer, at most 50;
 * the first one decides a write's 400.
 * 1. Document level, before any parsing: no `$`-key and no nesting past the limit anywhere, then
 *    the block cap (`/blocks`). Either stops the check with that one issue (refusedInput).
 * 2. Document level: the schema (DashboardDraftSchema): title, scope, vars, layouts, views,
 *    importance, and each block's shape as part of the document. Schema issues stop the check
 *    (the later layers need a well-formed document); they come in the schema's order (parseDraft).
 * 3. Per block, in block order: `Block#check`, the template method: the type's catalog entry (the
 *    viz fits the type, a data block has a query or a saved view, any other takes none), then the
 *    type's own rules (a filter sets a variable, an action names its action), then the block's
 *    query compiled against the whitelist (`/blocks/<i>/query…`).
 * 4. Document level: reserved variable names (`/vars/<name>`), then the secret scan over the whole
 *    document (any string that looks like a token, wherever it sits).
 *
 * `lint` (validation layer 4) is per block, in block order: `Block#lint`, the template method:
 * fields (`private_field`, with the topic filters' `deleted_topic` among them), then a row
 * block's source link (`source_link_hidden`), then text (`hardcoded_text`). Its document-level
 * inputs are the mode (agents: mcp, where hard-coded text is an error) and the workspace's topic
 * ids.
 */
import { OpValidationError } from '../../builder/errors.js';
import type { LintIssue, LintMode, LintScope } from '../../builder/lint.js';
import {
  finalIssues,
  parseDraft,
  refusedInput,
  secretIssues,
  variableIssues,
  type DraftCheck,
} from '../../builder/validate.js';
import { AppError } from '../../errors/AppError.js';
import type { DashboardDraft } from '../../types/builder.js';
import type { DashboardValidation } from '../../types/dashboards.js';
import { Block } from './blocks/index.js';
import { issue, lintIssue } from './dashboardRules.js';

/** One block's issues, their pointers put under the block's: `/blocks/<index>…`. */
function underBlock<TIssue extends { pointer: string }>(
  index: number,
  issues: readonly TIssue[],
): TIssue[] {
  return issues.map((found) => ({ ...found, pointer: `/blocks/${String(index)}${found.pointer}` }));
}

export class DocCheck {
  static readonly instance = new DocCheck();

  private constructor() {
    // One instance: DocCheck.instance.
  }

  /**
   * The document as parsed (null when it is not even well-formed) and every schema, block,
   * variable and secret issue found, in the order above. Valid means no issues.
   */
  check(input: unknown): DraftCheck {
    const refused = refusedInput(input);
    if (refused !== null) return { draft: null, issues: [refused] };
    const parsed = parseDraft(input);
    const { draft } = parsed;
    if (draft === null) return parsed;
    const issues = [
      ...draft.blocks.flatMap((json, index) => underBlock(index, Block.from(json).check())),
      ...variableIssues(draft),
      ...secretIssues(draft),
    ];
    return { draft, issues: finalIssues(issues) };
  }

  /**
   * Lint issues of a schema-valid document, in block order, in the actor's mode. `topicIds`: the
   * workspace's topics, for the deleted-page check (skipped without them).
   */
  lint(doc: DashboardDraft, mode: LintMode, topicIds?: ReadonlySet<string>): LintIssue[] {
    const scope: LintScope = { mode, topicIds };
    return doc.blocks.flatMap((json, index) => underBlock(index, Block.from(json).lint(scope)));
  }

  /**
   * `{draft}` checked as a write would check it, every finding reported (`POST …/builder/validate`,
   * builder_validate): the check's issues and the lint's errors, then its warnings.
   */
  validation(input: unknown, mode: LintMode, topicIds: ReadonlySet<string>): DashboardValidation {
    const check = this.check(input);
    const lint = check.draft === null ? [] : this.lint(check.draft, mode, topicIds);
    const errors = [
      ...check.issues.map((found) => issue('invalid', found.pointer, found.message)),
      ...lint.filter((found) => found.severity === 'error').map(lintIssue),
    ];
    const warnings = lint.filter((found) => found.severity === 'warning').map(lintIssue);
    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * A document a write takes: validation, then lint in `mode` (without the deleted-page check);
   * OpValidationError (400) on the first issue or the first lint error.
   */
  validated(input: unknown, mode: LintMode): DashboardDraft {
    const check = this.check(input);
    const [first] = check.issues;
    if (check.draft === null || first !== undefined) {
      throw new OpValidationError(first?.pointer ?? '', first?.message ?? 'invalid dashboard');
    }
    const [blocking] = this.lint(check.draft, mode).filter((found) => found.severity === 'error');
    if (blocking !== undefined) throw new OpValidationError(blocking.pointer, blocking.message);
    return check.draft;
  }

  /**
   * A state rebuilt from history (undo, redo, revert), re-validated: the catalog may have changed
   * since it was written (409 if it no longer passes). A person's restore is not linted again (in
   * the UI, lint only warns). An agent's restore is held to mcp-mode lint like its ops, so history
   * can't bring back hard-coded text for it: OpValidationError (400) on the first lint error.
   */
  restorable(state: DashboardDraft, action: string, byAgent: boolean): DashboardDraft {
    const check = this.check(state);
    if (check.draft === null || check.issues.length > 0) {
      throw new AppError(409, `Cannot ${action}: the result would not be a valid dashboard`);
    }
    if (byAgent) {
      const [blocking] = this.lint(check.draft, 'mcp').filter(
        (found) => found.severity === 'error',
      );
      if (blocking !== undefined) throw new OpValidationError(blocking.pointer, blocking.message);
    }
    return check.draft;
  }
}
