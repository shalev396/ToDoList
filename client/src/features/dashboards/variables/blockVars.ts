/**
 * The page variables one block's query depends on: the ones it listens to (`listen`) plus every
 * `$page` reference in its query (a rule value, the date range). Only those are sent with its
 * `/query` request and hashed into its cache key, so a variable the block ignores never refetches
 * it.
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

/** Bare names, sorted. */
export function blockVarNames(block: Pick<Block, 'listen' | 'query'>): string[] {
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
  return [...names].sort();
}

/**
 * The block's variables from the page's, keyed `$page.<name>` as `/query` takes them. An explicit
 * null stays (it overrides the dashboard's default); a name the page does not know is left out.
 */
export function selectBlockVars(block: Pick<Block, 'listen' | 'query'>, vars: PageVars): QueryVars {
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
