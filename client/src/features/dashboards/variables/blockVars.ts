/**
 * The page variables one block's query depends on: the ones it listens to (`listen`), every
 * `$page` reference in its query (a rule value, the date range), and the ones its `hide` display
 * rules read (the server decides with them whether a hidden to-do still hides its provider copy,
 * H5; a chart or counter hides no row, so its hide rules read nothing). Only those are sent with
 * its `/query` request and hashed into its cache key, so a variable the block ignores never
 * refetches it.
 */
import type { Block, QueryVars, RuleGroup, VarValue } from '@api-types/builder.ts';
import { varNameOf, varRef } from './names.ts';
import { isDateRange, type PageVars } from './urlVars.ts';

function collectRuleRefs(group: RuleGroup, into: Set<string>): void {
  for (const node of group.rules) {
    if ('combinator' in node) {
      collectRuleRefs(node, into);
    } else if (typeof node.value === 'string') {
      // As the server reads them: a whole value is a reference; text inside a list is literal.
      const name = varNameOf(node.value);
      if (name !== null) {
        into.add(name);
      }
    }
  }
}

/** Blocks that show counts or groups, not rows: no row is hidden there (the server agrees). */
const COUNTING_BLOCKS: ReadonlySet<string> = new Set(['chart', 'counter']);

/** The whole-value `$page` references of the block's `hide` display rules. */
function collectHideRefs(block: Partial<Pick<Block, 'type' | 'rules'>>, into: Set<string>): void {
  if (block.type !== undefined && COUNTING_BLOCKS.has(block.type)) {
    return;
  }
  for (const rule of block.rules ?? []) {
    if (!('hide' in rule.then) || typeof rule.if.value !== 'string') {
      continue;
    }
    const name = varNameOf(rule.if.value);
    if (name !== null) {
      into.add(name);
    }
  }
}

/** What of a block decides its variables: `type` and `rules` only for its hide rules. */
export type BlockVarSource = Pick<Block, 'listen' | 'query'> &
  Partial<Pick<Block, 'type' | 'rules'>>;

/** Bare names, sorted. */
export function blockVarNames(block: BlockVarSource): string[] {
  const names = new Set<string>();
  for (const ref of block.listen ?? []) {
    const name = varNameOf(ref);
    if (name !== null) {
      names.add(name);
    }
  }
  const { query } = block;
  if (query !== undefined) {
    if (typeof query.dateRange === 'string') {
      const name = varNameOf(query.dateRange);
      if (name !== null) {
        names.add(name);
      }
    }
    if (query.where !== undefined) {
      collectRuleRefs(query.where, names);
    }
  }
  collectHideRefs(block, names);
  return [...names].sort();
}

/**
 * The block's variables from the page's, keyed `$page.<name>` as `/query` takes them. An explicit
 * null stays (it overrides the dashboard's default); a name the page does not know is left out.
 */
export function selectBlockVars(block: BlockVarSource, vars: PageVars): QueryVars {
  const selected: QueryVars = {};
  for (const name of blockVarNames(block)) {
    if (Object.hasOwn(vars, name)) {
      selected[varRef(name)] = vars[name] ?? null;
    }
  }
  return selected;
}

function canonical(value: VarValue): VarValue {
  return isDateRange(value) ? { from: value.from, to: value.to } : value;
}

/** A stable text for the selected variables: the same values give the same text, in any order. */
export function varsHash(selected: QueryVars): string {
  const entries = Object.entries(selected)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => [name, canonical(value)] as const);
  return JSON.stringify(Object.fromEntries(entries));
}
