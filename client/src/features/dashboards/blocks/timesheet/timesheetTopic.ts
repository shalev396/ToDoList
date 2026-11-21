/**
 * The topic a timesheet reads, and its switch: its query's top-level `topic` rule (`$page.topic`,
 * one page, or none for every page) and `viz.showBlocks`. Apart from timesheetModel.ts so the block
 * editor reads them without the week's occurrence expansion. Pure; unit-tested.
 */
import type { Query, Rule, RuleGroup } from '@api-types/builder.ts';

const PAGE_TOPIC = '$page.topic';

/** The page's topic (`$page.topic`: every topic on the main page), every topic, or one topic. */
export type TopicChoice = { kind: 'page' } | { kind: 'all' } | { kind: 'topic'; id: string };

function isTopicRule(node: Rule | RuleGroup): node is Rule {
  return !('combinator' in node) && node.field === 'topic' && node.operator === '=';
}

/** The top-level `topic =` rule of the query's `and` group, if it has one. */
function topicRuleOf(query: Query | undefined): Rule | undefined {
  const where = query?.where;
  if (where?.combinator !== 'and' || where.not === true) {
    return undefined;
  }
  return where.rules.find(isTopicRule);
}

export function topicChoiceOf(query: Query | undefined): TopicChoice {
  const value = topicRuleOf(query)?.value;
  if (value === PAGE_TOPIC) {
    return { kind: 'page' };
  }
  return typeof value === 'string' && value !== '' ? { kind: 'topic', id: value } : { kind: 'all' };
}

/** The query reading the topic chosen: its top-level topic rule replaced, added or taken off. */
export function withTopicChoice(query: Query, choice: TopicChoice): Query {
  const rule: Rule | null =
    choice.kind === 'all'
      ? null
      : {
          field: 'topic',
          operator: '=',
          value: choice.kind === 'page' ? PAGE_TOPIC : choice.id,
        };
  const where = query.where;
  let rules: RuleGroup['rules'];
  if (where === undefined) {
    rules = [];
  } else if (where.combinator === 'and' && where.not !== true) {
    rules = where.rules.filter((node) => !isTopicRule(node));
  } else {
    rules = [where];
  }
  const next = rule === null ? rules : [rule, ...rules];
  const rest: Query = { ...query };
  delete rest.where;
  if (next.length === 0) {
    return rest;
  }
  return {
    ...rest,
    where: {
      ...(where?.combinator === 'and' && where.not !== true ? where : {}),
      combinator: 'and',
      rules: next,
    },
  };
}

/**
 * The topic a new area gets: the page's (`$page.topic`'s value), the one picked, or none when the
 * timesheet reads every topic.
 */
export function timesheetTopicId(
  query: Query | undefined,
  vars: Readonly<Record<string, unknown>>,
): string | null {
  const choice = topicChoiceOf(query);
  if (choice.kind === 'topic') {
    return choice.id;
  }
  const page = vars['topic'];
  return choice.kind === 'page' && typeof page === 'string' && page !== '' ? page : null;
}

/**
 * The block's `listen` with `$page.topic` in it exactly when something of the block still reads
 * it (its query, its display rules): picking one topic, or every topic, takes it off.
 */
export function withTopicListen(listen: readonly string[], ...readers: unknown[]): string[] {
  const reads = readers.some((reader) =>
    JSON.stringify(reader ?? null).includes(JSON.stringify(PAGE_TOPIC)),
  );
  if (reads) {
    return listen.includes(PAGE_TOPIC) ? [...listen] : [...listen, PAGE_TOPIC];
  }
  return listen.filter((variable) => variable !== PAGE_TOPIC);
}

/** Whether the time blocks show: on unless the block turns them off. */
export function showsBlocks(viz: Readonly<Record<string, unknown>>): boolean {
  return viz['showBlocks'] !== false;
}
