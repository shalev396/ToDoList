/**
 * The sentence-style filter (H4): "Show [tasks] from [ClickUp, Jira] where [status] [is not]
 * [done], sorted by [importance]". It is another view of the same `Query` the rule tree edits, so
 * the two round-trip without loss:
 *
 * - `toSentence` reads a query's `where` (one flat AND group) and `sort` into clauses, in the
 *   order the rules are stored. A `kind in [...]` rule becomes the "[tasks]" slot and a
 *   `source.provider in [...]` rule the "from [...]" slot; every other rule is a condition.
 * - `fromSentence` writes the clauses back in the same order, so reading and writing an untouched
 *   query returns it exactly.
 * - A query the sentence cannot show without losing something (nested groups, OR, NOT, a
 *   containers query) is reported as unsupported, and the editor offers Advanced.
 */
import type { Query, Rule, RuleGroup, Sort } from '@api-types/builder.ts';

export type Clause =
  | { type: 'kinds'; values: string[] }
  | { type: 'providers'; values: string[] }
  | { type: 'rule'; rule: Rule };

export interface Sentence {
  clauses: Clause[];
  /** The first sort key: the sentence's "sorted by". */
  sort: Sort | null;
  /** Further sort keys, kept as they are. */
  moreSort: Sort[];
}

export type Unsupported = 'containers' | 'groups' | 'or' | 'not';
export type SentenceRead = { ok: true; sentence: Sentence } | { ok: false; reason: Unsupported };

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null;
}

function slotRule(rule: Rule, field: string): string[] | null {
  return rule.field === field && rule.operator === 'in' ? strings(rule.value) : null;
}

export function toSentence(query: Query): SentenceRead {
  if (query.source !== 'items') {
    return { ok: false, reason: 'containers' };
  }
  const clauses: Clause[] = [];
  const where = query.where;
  if (where !== undefined) {
    if (where.not === true) {
      return { ok: false, reason: 'not' };
    }
    if (where.combinator === 'or' && where.rules.length > 1) {
      return { ok: false, reason: 'or' };
    }
    let hasKinds = false;
    let hasProviders = false;
    for (const node of where.rules) {
      if ('combinator' in node) {
        return { ok: false, reason: 'groups' };
      }
      const kinds = hasKinds ? null : slotRule(node, 'kind');
      const providers = hasProviders ? null : slotRule(node, 'source.provider');
      if (kinds !== null) {
        hasKinds = true;
        clauses.push({ type: 'kinds', values: kinds });
      } else if (providers !== null) {
        hasProviders = true;
        clauses.push({ type: 'providers', values: providers });
      } else {
        clauses.push({ type: 'rule', rule: { ...node } });
      }
    }
  }
  const [first, ...rest] = query.sort ?? [];
  return { ok: true, sentence: { clauses, sort: first ?? null, moreSort: rest } };
}

function ruleOf(clause: Clause): Rule {
  switch (clause.type) {
    case 'kinds':
      return { field: 'kind', operator: 'in', value: [...clause.values] };
    case 'providers':
      return { field: 'source.provider', operator: 'in', value: [...clause.values] };
    case 'rule':
      return clause.rule;
  }
}

/** The query with its `where` and `sort` taken from the sentence; its other parts are kept. */
export function fromSentence(query: Query, sentence: Sentence): Query {
  const next: Query = { ...query };
  if (sentence.clauses.length === 0) {
    Reflect.deleteProperty(next, 'where');
  } else {
    const where: RuleGroup = { combinator: 'and', rules: sentence.clauses.map(ruleOf) };
    next.where = where;
  }
  const sort = [...(sentence.sort === null ? [] : [sentence.sort]), ...sentence.moreSort];
  if (sort.length === 0) {
    Reflect.deleteProperty(next, 'sort');
  } else {
    next.sort = sort;
  }
  return next;
}

/** Rules the sentence writes: every clause is one rule (the caps count them). */
export function ruleCountOf(sentence: Sentence): number {
  return sentence.clauses.length;
}

function without<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, at) => at !== index);
}

/** Sets the "[tasks]" slot in place; an empty list removes it. */
export function setKinds(sentence: Sentence, values: readonly string[]): Sentence {
  return setSlot(sentence, 'kinds', values, 0);
}

/** Sets the "from [...]" slot in place; an empty list removes it. */
export function setProviders(sentence: Sentence, values: readonly string[]): Sentence {
  const afterKinds = sentence.clauses.some((clause) => clause.type === 'kinds') ? 1 : 0;
  return setSlot(sentence, 'providers', values, afterKinds);
}

function setSlot(
  sentence: Sentence,
  type: 'kinds' | 'providers',
  values: readonly string[],
  insertAt: number,
): Sentence {
  const at = sentence.clauses.findIndex((clause) => clause.type === type);
  if (at >= 0) {
    return {
      ...sentence,
      clauses:
        values.length === 0
          ? without(sentence.clauses, at)
          : sentence.clauses.map((clause, index) =>
              index === at ? { type, values: [...values] } : clause,
            ),
    };
  }
  if (values.length === 0) {
    return sentence;
  }
  const clauses = [...sentence.clauses];
  clauses.splice(insertAt, 0, { type, values: [...values] });
  return { ...sentence, clauses };
}

export function addRule(sentence: Sentence, rule: Rule): Sentence {
  return { ...sentence, clauses: [...sentence.clauses, { type: 'rule', rule }] };
}

export function replaceRule(sentence: Sentence, index: number, rule: Rule): Sentence {
  return {
    ...sentence,
    clauses: sentence.clauses.map((clause, at) =>
      at === index && clause.type === 'rule' ? { type: 'rule', rule } : clause,
    ),
  };
}

export function removeClause(sentence: Sentence, index: number): Sentence {
  return { ...sentence, clauses: without(sentence.clauses, index) };
}

export function setSort(sentence: Sentence, sort: Sort | null): Sentence {
  // The sentence's sort key may not repeat one of the kept ones.
  const moreSort =
    sort === null
      ? sentence.moreSort
      : sentence.moreSort.filter((entry) => entry.field !== sort.field);
  return { ...sentence, sort, moreSort };
}

/**
 * Fills `{name}` slots of an i18n template with parts: "Show {kinds} from {providers}" becomes
 * ["Show ", kinds, " from ", providers]. A language orders the slots as it reads (Hebrew does not
 * follow the English word order); a slot a template leaves out is simply not shown.
 */
export function templateParts<T>(
  template: string,
  slots: Readonly<Record<string, T>>,
): (string | T)[] {
  const parts: (string | T)[] = [];
  for (const piece of template.split(/(\{[a-zA-Z]+\})/)) {
    const name = /^\{([a-zA-Z]+)\}$/.exec(piece)?.[1];
    if (name === undefined) {
      if (piece !== '') {
        parts.push(piece);
      }
    } else if (Object.hasOwn(slots, name)) {
      parts.push(slots[name] as T);
    }
  }
  return parts;
}
