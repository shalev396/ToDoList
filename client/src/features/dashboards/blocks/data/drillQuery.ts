import type { Query, Rule, RuleGroup } from '@api-types/builder.ts';

/**
 * The query behind a chart segment's drill Sheet: the block's own filters plus "field = key", as
 * rows (no grouping or aggregate), newest due first, at most 20 (a preview run).
 */
export function drillQuery(query: Query, field: string, key: string): Query {
  const rest: Query = { ...query };
  delete rest.groupBy;
  delete rest.aggregate;
  const rule: Rule = { field, operator: '=', value: key };
  const where: RuleGroup = {
    combinator: 'and',
    rules: query.where === undefined ? [rule] : [query.where, rule],
  };
  return { ...rest, where, sort: [{ field: 'dueAt', dir: 'asc' }], limit: 20 };
}
