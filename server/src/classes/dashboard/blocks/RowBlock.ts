import { lintSourceLink, type LintIssue } from '../../../builder/lint.js';
import { QueryBlock } from './QueryBlock.js';

/**
 * A data block that renders rows, each linking back to its source ("Open in <provider>",
 * BUILDER.md §8): its lint refuses a viz option that turns the link off (`source_link_hidden`).
 */
export abstract class RowBlock extends QueryBlock {
  protected override lintSpecific(): LintIssue[] {
    return lintSourceLink(this.json);
  }
}
