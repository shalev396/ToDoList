/**
 * Logic v2 operators (H4): each compiles to safe Mongo; relative dates resolve to local-day
 * boundaries of the workspace time zone (DST-safe); dynamic fields and attributes are checked
 * against the workspace's registry; nothing user-supplied becomes an operator or a key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BUILTIN_IMPORTANCE, type AttributeDef } from '../types/attributes.js';
import { CAPS, OPERATORS, type Query } from '../types/builder.js';
import { FIELD_CATALOG, OPERATORS_BY_TYPE } from './catalog.js';
import type { FieldType } from '../types/builder.js';
import { compileQuery, type CompileContext } from './compile.js';
import { resolveRelative } from './dates.js';
import { QueryValidationError } from './errors.js';

const NOW = new Date('2026-11-11T08:00:00Z'); // Wednesday, 10:00 in Jerusalem

function context(overrides: Partial<CompileContext> = {}): CompileContext {
  return {
    ws: { id: 'w-1' },
    userId: 'u-1',
    access: { userId: 'u-1', integrations: [], local: 'visible' },
    vars: {},
    now: NOW,
    timeZone: 'Asia/Jerusalem',
    weekStart: 'sun',
    preview: false,
    ...overrides,
  };
}

/** The query's `$match` filter (the stage after the base filter and any `$addFields`). */
function filter(
  rule: unknown,
  ctx = context(),
  source: 'items' | 'containers' = 'items',
): Record<string, unknown> {
  const query = { source, where: { combinator: 'and', rules: [rule] } } as Query;
  const compiled = compileQuery(query, ctx);
  const match = compiled.pipeline.filter((stage) => '$match' in stage)[1];
  return match?.['$match'] as Record<string, unknown>;
}

function fails(rule: unknown, ctx = context(), source: 'items' | 'containers' = 'items'): void {
  assert.throws(
    () => filter(rule, ctx, source),
    (error: unknown) => error instanceof QueryValidationError,
  );
}

describe('text operators', () => {
  it('notContains negates an escaped, case-insensitive regex', () => {
    assert.deepEqual(filter({ field: 'title', operator: 'notContains', value: 'a.b*' }), {
      title: { $not: { $regex: 'a\\.b\\*', $options: 'i' } },
    });
  });

  it('endsWith anchors the end', () => {
    assert.deepEqual(filter({ field: 'title', operator: 'endsWith', value: 'x(' }), {
      title: { $regex: 'x\\($', $options: 'i' },
    });
  });

  it('refuses a regex source longer than the cap', () => {
    fails({ field: 'title', operator: 'notContains', value: 'a'.repeat(CAPS.maxRegexLength + 1) });
    fails({ field: 'title', operator: 'endsWith', value: 'a'.repeat(CAPS.maxRegexLength + 1) });
  });

  it('is set / is not set are null / notNull', () => {
    assert.deepEqual(filter({ field: 'title', operator: 'notNull' }), { title: { $ne: null } });
  });
});

describe('number operators', () => {
  it('between and notBetween take two ordered numbers', () => {
    assert.deepEqual(filter({ field: 'priority', operator: 'between', value: [1, 3] }), {
      priority: { $gte: 1, $lte: 3 },
    });
    assert.deepEqual(filter({ field: 'priority', operator: 'notBetween', value: [1, 3] }), {
      priority: { $not: { $gte: 1, $lte: 3 } },
    });
    fails({ field: 'priority', operator: 'between', value: [3, 1] });
    fails({ field: 'priority', operator: 'between', value: ['1', 3] });
    fails({ field: 'priority', operator: 'between', value: [1] });
  });
});

describe('list operators', () => {
  it('any of, all of, none of, does not contain', () => {
    assert.deepEqual(filter({ field: 'labels', operator: 'in', value: ['a', 'b'] }), {
      labels: { $in: ['a', 'b'] },
    });
    assert.deepEqual(filter({ field: 'labels', operator: 'allOf', value: ['a', 'b'] }), {
      labels: { $all: ['a', 'b'] },
    });
    assert.deepEqual(filter({ field: 'labels', operator: 'noneOf', value: ['a'] }), {
      labels: { $nin: ['a'] },
    });
    assert.deepEqual(filter({ field: 'labels', operator: 'notContains', value: 'a' }), {
      labels: { $ne: 'a' },
    });
    fails({ field: 'labels', operator: 'allOf', value: [] });
  });

  it('refuses list operators on scalar fields', () => {
    fails({ field: 'title', operator: 'allOf', value: ['a'] });
    fails({ field: 'status', operator: 'endsWith', value: 'a' });
  });
});

describe('date operators', () => {
  it('on / notOn cover the whole local day of the date', () => {
    // 2026-11-11 in Jerusalem (IST, +2): 2026-11-10T22:00Z to 2026-11-11T22:00Z.
    const window = {
      $gte: new Date('2026-11-10T22:00:00Z'),
      $lt: new Date('2026-11-11T22:00:00Z'),
    };
    assert.deepEqual(filter({ field: 'dueAt', operator: 'on', value: '2026-11-11T09:30:00Z' }), {
      dueAt: window,
    });
    assert.deepEqual(filter({ field: 'dueAt', operator: 'notOn', value: '2026-11-11T09:30:00Z' }), {
      dueAt: { $not: window },
    });
  });

  it('on uses the 25-hour day when the clocks go back (2026-10-25)', () => {
    const match = filter({ field: 'dueAt', operator: 'on', value: '2026-10-25T10:00:00Z' });
    assert.deepEqual(match, {
      dueAt: {
        $gte: new Date('2026-10-24T21:00:00Z'),
        $lt: new Date('2026-10-25T22:00:00Z'),
      },
    });
  });

  it('inLast: from the start of the day n units ago to the end of today', () => {
    assert.deepEqual(filter({ field: 'dueAt', operator: 'inLast', value: [7, 'days'] }), {
      dueAt: {
        $gte: new Date('2026-11-03T22:00:00Z'),
        $lt: new Date('2026-11-11T22:00:00Z'),
      },
    });
  });

  it('inNext: from the start of today to the end of the day n units ahead', () => {
    assert.deepEqual(filter({ field: 'dueAt', operator: 'inNext', value: [7, 'days'] }), {
      dueAt: {
        $gte: new Date('2026-11-10T22:00:00Z'),
        $lt: new Date('2026-11-18T22:00:00Z'),
      },
    });
  });

  it('notInLast and notInNext negate the window; moreThanAgo is open-ended', () => {
    const last = filter({ field: 'dueAt', operator: 'notInLast', value: [1, 'weeks'] });
    assert.ok('$not' in (last['dueAt'] as object));
    assert.deepEqual(filter({ field: 'dueAt', operator: 'moreThanAgo', value: [2, 'days'] }), {
      dueAt: { $lt: new Date('2026-11-08T22:00:00Z') },
    });
    const next = filter({ field: 'dueAt', operator: 'notInNext', value: [3, 'days'] });
    assert.ok('$not' in (next['dueAt'] as object));
  });

  it('refuses a bad count or unit', () => {
    fails({ field: 'dueAt', operator: 'inLast', value: [-1, 'days'] });
    fails({ field: 'dueAt', operator: 'inLast', value: [1.5, 'days'] });
    fails({ field: 'dueAt', operator: 'inLast', value: [10_000, 'days'] });
    fails({ field: 'dueAt', operator: 'inLast', value: [1, 'years'] });
    fails({ field: 'dueAt', operator: 'inLast', value: 7 });
    fails({ field: 'dueAt', operator: 'inLast', value: [7] });
  });

  it('between and notBetween take two ordered dates', () => {
    const value = ['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'];
    assert.deepEqual(filter({ field: 'dueAt', operator: 'between', value }), {
      dueAt: { $gte: new Date(value[0] ?? ''), $lte: new Date(value[1] ?? '') },
    });
    assert.ok(
      '$not' in (filter({ field: 'dueAt', operator: 'notBetween', value })['dueAt'] as object),
    );
    fails({ field: 'dueAt', operator: 'between', value: [value[1], value[0]] });
  });
});

describe('relative dates and daylight saving (Asia/Jerusalem)', () => {
  const zone = 'Asia/Jerusalem';

  it('across the autumn change: days are local, not 24 hours', () => {
    const now = new Date('2026-10-26T09:00:00Z'); // Monday 11:00 IST, the day after the change
    const last = resolveRelative('inLast', 7, 'days', now, zone);
    // Oct 19 00:00 is still IDT (+3); Oct 27 00:00 is IST (+2).
    assert.equal(last.from.toISOString(), '2026-10-18T21:00:00.000Z');
    assert.equal(last.to.toISOString(), '2026-10-26T22:00:00.000Z');
    const next = resolveRelative('inNext', 2, 'days', now, zone);
    assert.equal(next.from.toISOString(), '2026-10-25T22:00:00.000Z');
    assert.equal(next.to.toISOString(), '2026-10-28T22:00:00.000Z');
  });

  it('across the spring change: the 23-hour day (2026-03-27) is one day', () => {
    const now = new Date('2026-03-26T10:00:00Z');
    const next = resolveRelative('inNext', 1, 'days', now, zone);
    assert.equal(next.from.toISOString(), '2026-03-25T22:00:00.000Z');
    assert.equal(next.to.toISOString(), '2026-03-27T21:00:00.000Z');
  });

  it('weeks are seven days; months are calendar months, the day clamped', () => {
    const now = new Date('2026-03-31T09:00:00Z');
    assert.equal(
      resolveRelative('inLast', 1, 'weeks', now, zone).from.toISOString(),
      resolveRelative('inLast', 7, 'days', now, zone).from.toISOString(),
    );
    // One month before Mar 31 is Feb 28 (2026 is not a leap year); local midnight, IST.
    assert.equal(
      resolveRelative('inLast', 1, 'months', now, zone).from.toISOString(),
      '2026-02-27T22:00:00.000Z',
    );
  });

  it('a zone west of UTC resolves the same instant to a different local day', () => {
    const now = new Date('2026-11-11T03:00:00Z'); // Nov 10, 22:00 in New York
    const last = resolveRelative('inLast', 0, 'days', now, 'America/New_York');
    assert.equal(last.from.toISOString(), '2026-11-10T05:00:00.000Z');
    assert.equal(last.to.toISOString(), '2026-11-11T05:00:00.000Z');
  });
});

describe('operator table', () => {
  it('every operator of the schema is allowed on some field type, and nothing else is', () => {
    const allowed = new Set(Object.values(OPERATORS_BY_TYPE).flat());
    for (const operator of OPERATORS) {
      if (operator === 'within') continue;
      assert.ok(allowed.has(operator), operator);
    }
    for (const operator of allowed) assert.ok((OPERATORS as readonly string[]).includes(operator));
  });

  it('every catalog field only lists operators of its type', () => {
    for (const fields of Object.values(FIELD_CATALOG)) {
      for (const spec of Object.values(fields)) {
        assert.deepEqual(spec.operators, OPERATORS_BY_TYPE[spec.type]);
      }
    }
  });
});

describe('dynamic provider fields', () => {
  const registry = new Map<string, FieldType>([
    ['props.jira.storyPoints', 'number'],
    ['props.storyPoints', 'number'],
    ['props.jira.due', 'date'],
  ]);

  it('accepts a registered provider path and refuses an unregistered one', () => {
    const ctx = context({ fieldRegistry: registry });
    assert.deepEqual(filter({ field: 'props.jira.storyPoints', operator: '>', value: 3 }, ctx), {
      'props.jira.storyPoints': { $gt: 3 },
    });
    fails({ field: 'props.jira.other', operator: '>', value: 3 }, ctx);
    fails({ field: 'props.github.x', operator: '=', value: 1 }, ctx);
  });

  it('a registered field has its inferred type: a date field takes date operators', () => {
    const ctx = context({ fieldRegistry: registry });
    assert.ok(
      'props.jira.due' in
        filter({ field: 'props.jira.due', operator: 'inNext', value: [3, 'days'] }, ctx),
    );
    fails({ field: 'props.jira.storyPoints', operator: 'inNext', value: [3, 'days'] }, ctx);
    fails({ field: 'props.jira.storyPoints', operator: 'contains', value: 'x' }, ctx);
  });

  it('without a registry the strict pattern still applies', () => {
    assert.ok(
      'props.jira.storyPoints' in
        filter({ field: 'props.jira.storyPoints', operator: '>', value: 3 }),
    );
    fails({ field: 'props.jira.a.b.c', operator: '=', value: 1 });
    fails({ field: 'props.jira.a-b', operator: '=', value: 1 });
    fails({ field: 'props.jira.token', operator: '=', value: 1 });
    fails({ field: 'props.jira.$where', operator: '=', value: 1 });
    fails({ field: 'props.jira.__proto__', operator: '=', value: 1 });
    fails({ field: 'props.jira..x', operator: '=', value: 1 });
  });
});

describe('attribute fields', () => {
  const stars: AttributeDef = { key: 'stars', name: 'Stars', type: 'rating', builtIn: false };
  const size: AttributeDef = {
    key: 'sz',
    name: 'Size',
    type: 'select',
    options: ['S', 'M'],
    builtIn: false,
  };
  const attributes = [BUILTIN_IMPORTANCE, stars, size];

  it('attr.<key> reads overlay.attrs.<key>, typed by the definition', () => {
    const ctx = context({ attributes });
    assert.deepEqual(filter({ field: 'attr.stars', operator: '>=', value: 4 }, ctx), {
      'overlay.attrs.stars': { $gte: 4 },
    });
    assert.deepEqual(filter({ field: 'attr.sz', operator: 'in', value: ['S'] }, ctx), {
      'overlay.attrs.sz': { $in: ['S'] },
    });
    fails({ field: 'attr.sz', operator: '=', value: 'XL' }, ctx);
    fails({ field: 'attr.stars', operator: '=', value: 'x' }, ctx);
  });

  it('an attribute the workspace does not define is refused', () => {
    fails({ field: 'attr.nope', operator: '=', value: 1 }, context({ attributes }));
  });

  it('refuses attr keys that are not slugs, and attr on containers', () => {
    fails({ field: 'attr.A', operator: '=', value: 1 }, context({ attributes }));
    fails({ field: 'attr.$x', operator: '=', value: 1 }, context({ attributes }));
    fails({ field: 'attr.stars', operator: '=', value: 1 }, context({ attributes }), 'containers');
  });

  it('the built-in Importance reads 3 when unset: an $addFields default before the match', () => {
    const compiled = compileQuery(
      {
        source: 'items',
        where: {
          combinator: 'and',
          rules: [{ field: 'attr.importance', operator: '>=', value: 3 }],
        },
      },
      context({ attributes }),
    );
    assert.deepEqual(compiled.pipeline[1], {
      $addFields: { 'overlay.attrs.importance': { $ifNull: ['$overlay.attrs.importance', 3] } },
    });
  });
});

describe('the computed importance field', () => {
  it('adds the score stage only when the query uses it, and never from a user value', () => {
    const plain = compileQuery({ source: 'items' }, context());
    assert.ok(!plain.pipeline.some((stage) => '$addFields' in stage));
    const sorted = compileQuery(
      { source: 'items', sort: [{ field: 'importance', dir: 'desc' }] },
      context({ attributes: [BUILTIN_IMPORTANCE] }),
    );
    assert.ok(sorted.pipeline.some((stage) => '$addFields' in stage));
    const filtered = filter({ field: 'importance', operator: '>=', value: 70 });
    assert.deepEqual(filtered, { importance: { $gte: 70 } });
  });

  it('refuses a $-keyed object where a value goes', () => {
    assert.throws(() =>
      compileQuery(
        {
          source: 'items',
          where: {
            combinator: 'and',
            rules: [{ field: 'importance', operator: '>=', value: { $function: {} } }],
          },
        } as unknown as Query,
        context(),
      ),
    );
  });
});
