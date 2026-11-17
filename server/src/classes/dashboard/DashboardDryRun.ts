/**
 * A dry run of a whole next state of a dashboard (builder_preview, a write tool's `dryRun`, undo's
 * and revert's previews, D12): nothing is written. The answer is whether the write would be taken
 * (validation, lint in the actor's mode, the connector rule), its diff from the current draft, the
 * blocks' preview rows and what it would share with the whole workspace.
 */
import type { OpValidationError } from '../../builder/errors.js';
import type { DashboardDraft } from '../../types/builder.js';
import type { DashboardDryRunResult } from '../../types/dashboards.js';
import type { Caller } from '../base/Caller.js';
import { Topic } from '../workspace/Topic.js';
import { BlockPreviews } from './BlockPreviews.js';
import { DashboardConnectors } from './DashboardConnectors.js';
import { issue, lintIssue, lintModeOf } from './dashboardRules.js';
import { DocCheck } from './DocCheck.js';
import { History } from './History.js';

export class DashboardDryRun {
  readonly #caller: Caller;

  private constructor(caller: Caller) {
    this.#caller = caller;
    Object.freeze(this);
  }

  /** Dry runs as the caller writes. */
  static for(caller: Caller): DashboardDryRun {
    return new DashboardDryRun(caller);
  }

  /** A dry run that stopped before any check could run: invalid, with the one error. */
  static refused(error: OpValidationError): DashboardDryRunResult {
    return {
      valid: false,
      errors: [issue('invalid', error.pointer, error.reason)],
      warnings: [],
      diff: [],
      preview: {},
      shares: [],
    };
  }

  /** `before` → `next`: validation, lint in the actor's mode, the connector rule, diff, rows. */
  async of(
    before: DashboardDraft,
    next: DashboardDraft,
    previewRows?: number,
  ): Promise<DashboardDryRunResult> {
    const caller = this.#caller;
    const check = DocCheck.instance.check(next);
    if (check.draft === null || check.issues.length > 0) {
      return {
        valid: false,
        errors: check.issues.map((found) => issue('invalid', found.pointer, found.message)),
        warnings: [],
        diff: [],
        preview: {},
        shares: [],
      };
    }
    const connectors = DashboardConnectors.of(caller);
    const lint = DocCheck.instance.lint(
      check.draft,
      lintModeOf(caller),
      await Topic.idsIn(caller.workspaceId),
    );
    const errors = [
      ...lint.filter((found) => found.severity === 'error').map(lintIssue),
      ...(await connectors.issues(before.blocks, check.draft.blocks)),
    ];
    const warnings = lint.filter((found) => found.severity === 'warning').map(lintIssue);
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      diff: History.patchOf(before, check.draft),
      preview: await BlockPreviews.for(caller).of(check.draft, previewRows),
      shares: await connectors.sharesOf(before.blocks, check.draft.blocks),
    };
  }
}
