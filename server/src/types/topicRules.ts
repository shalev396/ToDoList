/**
 * Topic rules, the parts the client shares (File under): the exact lookup of one container's name
 * rule, and the shapes of what filing answers.
 *
 * A name rule is an ordinary topic rule (`classes/workspace/TopicRules.ts`) whose `match` is a
 * container's name or match key. Its `match` is a glob, so a `*` in a calendar or project name
 * written into a rule stays a wildcard (Ruling F-A2): a rule for `Q1 *` files every container
 * whose name starts with `Q1 `, exactly as a rule typed in Settings does.
 *
 * Shared by the server and the client (`@api-types/topicRules`): pure TypeScript, no imports.
 */

/** A topic rule as stored and shown: `match` is a glob against a container's match key. */
export interface RuleShape {
  match: string;
  topicId: string;
}

/** How many rows a File under change moved. */
export interface RefileCounts {
  containers: number;
  items: number;
}

/** The answer of a File under change: the container's rule now (null = none) and what moved. */
export interface FileUnderResult {
  rule: RuleShape | null;
  refiled: RefileCounts;
}

const keyOf = (match: string): string => match.trim().toLowerCase();

/** True when two rules name the same container: equal ignoring case and surrounding spaces. */
export function sameRuleMatch(a: string, b: string): boolean {
  return keyOf(a) === keyOf(b);
}

/**
 * The one rule whose `match` equals `match` exactly (case-insensitive, no glob matching), or null.
 * What "this container has its own rule" means. The same function on the server (`TopicRules#ruleFor`)
 * and in the client's File under panel: there is no second copy.
 */
export function exactRuleFor<R extends RuleShape>(rules: readonly R[], match: string): R | null {
  return rules.find((rule) => sameRuleMatch(rule.match, match)) ?? null;
}
