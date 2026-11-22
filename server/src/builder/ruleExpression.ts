/**
 * A `$match` filter the rule compiler made (compile.ts, Compilation#rule and #group) as an
 * aggregation expression that is true for the documents the filter matches (one limit, below):
 * what a stage computing a value per row (H5's partition flag) needs, where a filter cannot go.
 *
 * MongoDB's query rules are kept: a list field matches a condition when one of its items does (and
 * equality and `$in` also by the whole list); a missing field equals null; `<`, `>` and the like
 * compare only values of the same type (a number with a number, a date with a date, text with
 * text); `$ne`, `$nin` and `$not` match whatever the positive form does not, missing fields too.
 * Every value is wrapped in `$literal`, so a user's text that starts with `$` stays text.
 *
 * One limit: on a dotted path that crosses a list of subdocuments (`props.s.b` where `props.s` is
 * `[{b: 1}, {c: 2}]`), null and missing are not MongoDB's. `$match` counts an item that lacks the
 * field as null; the expression reads only the items that have it (`[1]`). So `null`, `notNull`,
 * `!=` and `$in` with null can differ there, while equality on values, `$in` on values, `$all`,
 * text and comparisons agree. Only a dynamic `props.*` path read without a registry can be one
 * (the registry descends through plain objects only), and only a to-do's own row feeds the
 * absorption flag, so nothing differs in practice today.
 *
 * Only the shapes the rule compiler emits are known; anything else throws (FilterExpressionError).
 */
type Filter = Record<string, unknown>;
export type Expression = unknown;

/** A filter shape this module does not know: a compiler change this module must follow. */
export class FilterExpressionError extends Error {
  constructor(what: string) {
    super(`ruleExpression: ${what} is not a shape the rule compiler emits`);
    this.name = 'FilterExpressionError';
  }
}

const COMPARISON: Readonly<Record<string, string>> = {
  $lt: '$lt',
  $lte: '$lte',
  $gt: '$gt',
  $gte: '$gte',
};

function isPlainObject(value: unknown): value is Filter {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function literal(value: unknown): Expression {
  return { $literal: value };
}

/** True when `test` holds for the value, or (a list) for one of its items. */
function anyItem(value: Expression, test: (item: Expression) => Expression): Expression {
  return {
    $cond: [
      { $isArray: value },
      { $anyElementTrue: [{ $map: { input: value, as: 'item', in: test('$$item') } }] },
      test(value),
    ],
  };
}

function not(expression: Expression): Expression {
  return { $not: [expression] };
}

/** `{f: v}`: equal, or a list holding it; `{f: null}`: missing, null, or a list holding null. */
function equals(value: Expression, operand: unknown): Expression {
  if (operand === null) {
    return {
      $cond: [
        { $isArray: value },
        { $in: [null, value] },
        { $eq: [{ $ifNull: [value, null] }, null] },
      ],
    };
  }
  return {
    $cond: [
      { $isArray: value },
      { $in: [literal(operand), value] },
      { $eq: [value, literal(operand)] },
    ],
  };
}

/** `{f: {$in: list}}`: one of the list (a missing field is null), or a list sharing an item. */
function isIn(value: Expression, list: unknown): Expression {
  if (!Array.isArray(list)) throw new FilterExpressionError('a non-list $in');
  const values = literal(list);
  return {
    $cond: [
      { $isArray: value },
      {
        $or: [
          { $in: [value, values] },
          {
            $anyElementTrue: [
              { $map: { input: value, as: 'item', in: { $in: ['$$item', values] } } },
            ],
          },
        ],
      },
      { $in: [{ $ifNull: [value, null] }, values] },
    ],
  };
}

/** The type check a comparison with `operand` needs (MongoDB compares within one type only). */
function sameType(value: Expression, operand: unknown): Expression {
  if (typeof operand === 'number') return { $isNumber: value };
  if (operand instanceof Date) return { $eq: [{ $type: value }, 'date'] };
  if (typeof operand === 'string') return { $eq: [{ $type: value }, 'string'] };
  if (typeof operand === 'boolean') return { $eq: [{ $type: value }, 'bool'] };
  throw new FilterExpressionError('a comparison with this value');
}

function compare(value: Expression, operator: string, operand: unknown): Expression {
  const op = COMPARISON[operator];
  if (op === undefined) throw new FilterExpressionError(operator);
  return anyItem(value, (item) => ({
    $cond: [sameType(item, operand), { [op]: [item, literal(operand)] }, false],
  }));
}

function regex(value: Expression, pattern: unknown, options: unknown): Expression {
  if (typeof pattern !== 'string') throw new FilterExpressionError('a non-text $regex');
  const flags = typeof options === 'string' ? options : '';
  return anyItem(value, (item) => ({
    $cond: [
      { $eq: [{ $type: item }, 'string'] },
      { $regexMatch: { input: item, regex: literal(pattern), options: literal(flags) } },
      false,
    ],
  }));
}

/** `{f: {$all: list}}`: every item of the list is the value, or one of its items. */
function all(value: Expression, list: unknown): Expression {
  if (!Array.isArray(list) || list.length === 0) throw new FilterExpressionError('this $all');
  return {
    $setIsSubset: [literal(list), { $cond: [{ $isArray: value }, value, [value]] }],
  };
}

/** One operator object on a field (`{$gte: a, $lt: b}`, `{$regex, $options}`, `{$not: …}`). */
function conditions(value: Expression, spec: Filter): Expression {
  const parts: Expression[] = [];
  for (const [operator, operand] of Object.entries(spec)) {
    switch (operator) {
      case '$ne':
        parts.push(not(equals(value, operand)));
        break;
      case '$in':
        parts.push(isIn(value, operand));
        break;
      case '$nin':
        parts.push(not(isIn(value, operand)));
        break;
      case '$all':
        parts.push(all(value, operand));
        break;
      case '$regex':
        parts.push(regex(value, operand, spec['$options']));
        break;
      case '$options':
        if (!('$regex' in spec)) throw new FilterExpressionError('$options without $regex');
        break;
      case '$not':
        if (!isPlainObject(operand)) throw new FilterExpressionError('this $not');
        parts.push(not(conditions(value, operand)));
        break;
      default:
        parts.push(compare(value, operator, operand));
    }
  }
  if (parts.length === 0) throw new FilterExpressionError('an empty condition');
  return parts.length === 1 ? parts[0] : { $and: parts };
}

/**
 * The expression of `filter`. `field(path)` is the expression a field path reads (default
 * `'$<path>'`): a caller swaps in the expression of a field the pipeline has not computed yet.
 */
export function filterExpression(
  filter: Filter,
  field: (path: string) => Expression = (path) => `$${path}`,
): Expression {
  const parts: Expression[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(value) || value.length === 0) throw new FilterExpressionError(key);
      parts.push({
        [key]: value.map((part) => {
          if (!isPlainObject(part)) throw new FilterExpressionError(`a part of ${key}`);
          return filterExpression(part, field);
        }),
      });
    } else if (key === '$nor') {
      if (!Array.isArray(value) || value.length === 0) throw new FilterExpressionError(key);
      parts.push(
        not({
          $or: value.map((part) => {
            if (!isPlainObject(part)) throw new FilterExpressionError('a part of $nor');
            return filterExpression(part, field);
          }),
        }),
      );
    } else if (key.startsWith('$')) {
      throw new FilterExpressionError(key);
    } else if (isPlainObject(value)) {
      parts.push(conditions(field(key), value));
    } else if (Array.isArray(value)) {
      throw new FilterExpressionError('a list compared whole');
    } else {
      parts.push(equals(field(key), value));
    }
  }
  if (parts.length === 0) return true;
  return parts.length === 1 ? parts[0] : { $and: parts };
}
