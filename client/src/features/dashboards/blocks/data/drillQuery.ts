import type { Query, Rule, RuleGroup } from '@api-types/builder.ts';

/**
 * The query behind a chart segment's drill Sheet: the block's own filters plus "field = key", as
 * rows (no grouping or aggregate), at most 20 (a preview run). The value is the group's real one
 * (a number, a boolean ...), as the compiler checks it against the field's type. Items sort by due
 * date; containers have none, so they sort by name (the server's own default for them).
 */
export function drillQuery(query: Query, field: string, value: string | number | boolean): Query {
  const rest: Query = { ...query };
  delete rest.groupBy;
  delete rest.aggregate;
  const rule: Rule = { field, operator: '=', value };
  const where: RuleGroup = {
    combinator: 'and',
    rules: query.where === undefined ? [rule] : [query.where, rule],
  };
  return {
    ...rest,
    where,
    sort: [{ field: query.source === 'containers' ? 'name' : 'dueAt', dir: 'asc' }],
    limit: 20,
  };
}
