/**
 * Topic classification (BACKEND.md §5 rule 5, DATA.md §3.2; H2 dynamic topics): data, not code. A
 * workspace's `settings.topicRules` map a container's match key (its name, or what the adapter
 * chose, such as GitHub's "owner/repo") to a topic. The first matching rule wins; without a match
 * the integration's own topic applies, which may be none (Unsorted). Nothing user-specific lives
 * here (D17): rules are per-workspace data.
 *
 * Patterns are globs matched against the whole key, ignoring case: `*` matches any run of
 * characters, `/` and line breaks included. Every other character is literal.
 */
import type { IntegrationData } from '../models/definitions/Integration.js';
import type { TopicRule } from '../models/definitions/Workspace.js';

export interface TopicInput {
  /** What the rules are matched against, e.g. "shalev396/Elytra". */
  matchKey: string;
  /** The topic when no rule matches: the integration's (defaultTopicForIntegration); null = none. */
  defaultTopicId: string | null;
}

const REGEXP_SYNTAX = /[.*+?^${}()|[\]\\/]/g;

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(REGEXP_SYNTAX, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 'isu');
}

/** True when the glob `pattern` matches all of `key`, ignoring case. */
export function matchesTopicPattern(pattern: string, key: string): boolean {
  return globToRegExp(pattern).test(key);
}

/**
 * The topic of the first rule whose glob matches the key, ignoring case (GitHub logins and repo
 * names are case-insensitive, and a GitHub connect stores its `<login>/*` rule in lower case), else
 * the default topic.
 */
export function classifyTopic(input: TopicInput, rules: readonly TopicRule[]): string | null {
  for (const rule of rules) {
    if (matchesTopicPattern(rule.match, input.matchKey)) return rule.topicId;
  }
  return input.defaultTopicId;
}

/** The topic an integration's records get when no rule or override applies (set at connect time). */
export function defaultTopicForIntegration(
  integration: Pick<IntegrationData, 'topicId'>,
): string | null {
  return integration.topicId;
}
