import { CAPS, measureRuleGroup, type RuleGroup } from '@api-types/builder.ts';

/** Leaf rules across all nesting levels (the cap counts nested groups too). */
export function countRules(group: RuleGroup): number {
  return measureRuleGroup(group).rules;
}

/** Whether one more rule fits under the cap (server: CAPS.maxRules, builder/validate). */
export function canAddRule(group: RuleGroup | undefined): boolean {
  return (group === undefined ? 0 : countRules(group)) < CAPS.maxRules;
}

/** Whether one more group-by field fits. */
export function canAddGroupBy(groupBy: readonly string[] | undefined): boolean {
  return (groupBy?.length ?? 0) < CAPS.maxGroupBy;
}

/** Toggles a group-by field, refusing one past the cap. Returns the list unchanged then. */
export function toggleGroupBy(groupBy: readonly string[], field: string): string[] {
  if (groupBy.includes(field)) {
    return groupBy.filter((entry) => entry !== field);
  }
  return canAddGroupBy(groupBy) ? [...groupBy, field] : [...groupBy];
}
