/**
 * Topic classification (BACKEND.md §5 rule 5, DATA.md §3.2; H2 dynamic topics): data, not code. A
 * workspace's `settings.topicRules` map a container's match key (its name, or what the adapter
 * chose, such as GitHub's "owner/repo") to a topic. The first matching rule wins; without a match
 * the integration's own topic applies, which may be none (Unsorted). Nothing user-specific lives
 * here (D17): rules are per-workspace data.
 *
 * Patterns are globs matched against the whole key, ignoring case: `*` matches any run of
 * characters, `/` and line breaks included. Every other character is literal.
 *
 * `TopicRules` is the value object over a workspace's rules: immutable, validated when made from
 * a request (`normalize`), and the one place that classifies.
 */
import { AppError } from '../../errors/AppError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { TopicRule } from '../../models/definitions/Workspace.js';
import { hasTooManyWildcards, matchesGlob } from '../../types/glob.js';
import { exactRuleFor, sameRuleMatch } from '../../types/topicRules.js';

export interface TopicInput {
  /** What the rules are matched against, e.g. "shalev396/Elytra". */
  matchKey: string;
  /** The topic when no rule matches: the integration's (defaultFor); null = none. */
  defaultTopicId: string | null;
}

export class TopicRules {
  static readonly MAX = 50;
  static readonly MATCH_MAX = 200;
  static readonly empty = new TopicRules([]);

  readonly #rules: readonly Readonly<TopicRule>[];

  private constructor(rules: readonly TopicRule[]) {
    this.#rules = Object.freeze(
      rules.map(({ match, topicId }) => Object.freeze({ match, topicId })),
    );
    Object.freeze(this);
  }

  /** The rules as stored (already validated when they were saved). */
  static of(rules: readonly TopicRule[] | undefined): TopicRules {
    return rules === undefined || rules.length === 0 ? TopicRules.empty : new TopicRules(rules);
  }

  /** The rules of a request: trimmed, and 400 when there are too many or one is incomplete. */
  static normalize(rules: readonly TopicRule[]): TopicRules {
    if (rules.length > TopicRules.MAX) {
      throw new AppError(400, `At most ${String(TopicRules.MAX)} topic rules`);
    }
    return new TopicRules(
      rules.map(({ match, topicId }) => {
        const trimmed = match.trim();
        if (trimmed === '' || trimmed.length > TopicRules.MATCH_MAX || topicId === '') {
          throw new AppError(400, 'Each topic rule needs a match and a topic');
        }
        if (hasTooManyWildcards(trimmed)) {
          throw new AppError(400, 'A topic rule match has too many wildcards');
        }
        return { match: trimmed, topicId };
      }),
    );
  }

  /** True when the glob `pattern` matches all of `key`, ignoring case. */
  static matches(pattern: string, key: string): boolean {
    return matchesGlob(pattern, key);
  }

  /** The topic an integration's records get when no rule or override applies (set at connect time). */
  static defaultFor(integration: Pick<IntegrationData, 'topicId'>): string | null {
    return integration.topicId;
  }

  get size(): number {
    return this.#rules.length;
  }

  /** The topics the rules file into. */
  get topicIds(): string[] {
    return this.#rules.map((rule) => rule.topicId);
  }

  /**
   * The topic of the first rule whose glob matches the key, ignoring case (GitHub logins and repo
   * names are case-insensitive, and a GitHub connect stores its `<login>/*` rule in lower case),
   * else the default topic. The key is read trimmed, as File under stores its rule (`withRule`):
   * a calendar named "Braude " is filed by the rule "Braude".
   */
  classify(input: TopicInput): string | null {
    const key = input.matchKey.trim();
    for (const rule of this.#rules) {
      if (TopicRules.matches(rule.match, key)) return rule.topicId;
    }
    return input.defaultTopicId;
  }

  /**
   * The rules with `match`'s own rule (File under) replaced: any rule with the same match, ignoring
   * case, goes, and a topic puts the new rule first, so it beats a broader glob; null only removes.
   * `match` is stored as a glob like any other rule: a `*` in a calendar or project name stays a
   * wildcard (an ordinary name rule), and the rule then also files names the glob matches.
   */
  withRule(match: string, topicId: string | null): TopicRules {
    const kept = this.#rules.filter((rule) => !sameRuleMatch(rule.match, match));
    return new TopicRules(topicId === null ? kept : [{ match: match.trim(), topicId }, ...kept]);
  }

  /** The rule whose match is exactly `match`, ignoring case (never a glob match); null when none. */
  ruleFor(match: string): TopicRule | null {
    const found = exactRuleFor(this.#rules, match);
    return found === null ? null : { match: found.match, topicId: found.topicId };
  }

  equals(other: TopicRules): boolean {
    return JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON());
  }

  toJSON(): TopicRule[] {
    return this.#rules.map(({ match, topicId }) => ({ match, topicId }));
  }
}
