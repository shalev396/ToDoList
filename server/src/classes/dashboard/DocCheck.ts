/**
 * The one place a dashboard document's blocks are checked and linted (BUILDER.md §6–§7). Every
 * write, dry run, restore and validation of a dashboard goes through `DocCheck.instance`, and
 * nothing else calls the builder's checkDraft or lintDashboard for a dashboard.
 *
 * The blocks are still plain JSON here. Phase 6b replaces the two bodies below with the Block class
 * hierarchy (`Block.from(json).check()`: schema, then the common lint, then each type's own), and
 * no caller changes.
 */
import { lintDashboard, type LintIssue, type LintMode } from '../../builder/lint.js';
import { checkDraft, type DraftCheck } from '../../builder/validate.js';
import type { DashboardDraft } from '../../types/builder.js';

export class DocCheck {
  static readonly instance = new DocCheck();

  private constructor() {
    // One instance: DocCheck.instance.
  }

  /**
   * The document as parsed (null when it is not even well-formed) and every schema and block issue
   * found (bad queries, unknown fields, secret-shaped text). Valid means no issues.
   */
  check(input: unknown): DraftCheck {
    return checkDraft(input);
  }

  /**
   * Lint issues of a schema-valid document, in block order, in the actor's mode (agents: mcp, where
   * hard-coded text is an error). `topicIds`: the workspace's topics, for the deleted-page check.
   */
  lint(doc: DashboardDraft, mode: LintMode, topicIds?: ReadonlySet<string>): LintIssue[] {
    return lintDashboard(doc, mode, topicIds);
  }
}
