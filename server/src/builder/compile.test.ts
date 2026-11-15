import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  baseContainerFilter,
  baseItemFilter,
  baseItemFilterUnabsorbed,
} from '../services/accessFilter.js';
import { Overrides } from '../classes/item/Overrides.js';
import { BLOCK_TYPES, CAPS, type Query } from '../types/builder.js';
import { BLOCK_CATALOG } from './catalog.js';
import { compileQuery, parseQuery, type CompileContext, type CompiledQuery } from './compile.js';
import { QueryValidationError } from './errors.js';

const NOW = new Date('2026-11-11T08:00:00Z'); // Wednesday, 10:00 in Jerusalem

/** u-1 sees its own integration i-own and the shared i-shared (share-on-attach). */
const ACCESS: CompileContext['access'] = {
  userId: 'u-1',
  integrations: [
    { id: 'i-own', provider: 'jira', accountId: 'site', ownerUserId: 'u-1' },
    { id: 'i-shared', provider: 'jira', accountId: 'site', ownerUserId: 'u-2' },
  ],
  local: 'visible',
};

function context(overrides: Partial<CompileContext> = {}): CompileContext {
  return {
    ws: { id: 'w-1' },
    userId: 'u-1',
    access: ACCESS,
    vars: {},
    now: NOW,
    timeZone: 'Asia/Jerusalem',
    weekStart: 'sun',
    preview: false,
    ...overrides,
  };
}

function where(...rules: unknown[]): Query['where'] {
  return { combinator: 'and', rules } as Query['where'];
}

/**
 * The query's own filter stage, if any: the last `$match` before the facet (after the base filter,
 * the stored-field prefilter and, for items, the effective values).
 */
function filterOf(compiled: CompiledQuery): Record<string, unknown> | undefined {
  const stage = compiled.pipeline
    .slice(1, -1)
    .filter((entry) => '$match' in entry)
    .at(-1);
  return stage?.['$match'] as Record<string, unknown> | undefined;
}

function facetOf(compiled: CompiledQuery): Record<string, Record<string, unknown>[]> {
  const last = compiled.pipeline.at(-1);
  return last?.['$facet'] as Record<string, Record<string, unknown>[]>;
}

function stage(stages: Record<string, unknown>[] | undefined, name: string): unknown {
  return stages?.find((entry) => name in entry)?.[name];
}

/** Every object key in a value, at any depth. */
function allKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, keys);
  } else if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      allKeys(child, keys);
    }
  }
  return keys;
}

function rejects(
  query: unknown,
  pointer: string,
  ctx: CompileContext = context(),
): QueryValidationError {
  try {
    compileQuery(query as Query, ctx);
  } catch (error) {
    assert.ok(error instanceof QueryValidationError, String(error));
    assert.equal(error.pointer, pointer, error.message);
    return error;
  }
  assert.fail(`compiled a query that should fail at ${pointer}`);
}

const CATALOG_QUERIES: [string, Query][] = BLOCK_TYPES.flatMap((type) => {
  const query = BLOCK_CATALOG[type].defaults.query;
  return query === undefined ? [] : [[`${type} default`, query] as [string, Query]];
});

/** A spread of queries: every operator, nesting, vars, groupings, both sources. */
const QUERIES: [string, Query][] = [
  ['bare items', { source: 'items' }],
  ['bare containers', { source: 'containers' }],
  ...CATALOG_QUERIES,
  [
    'every items operator',
    {
      source: 'items',
      where: where(
        { field: 'status', operator: '!=', value: 'done' },
        { field: 'kind', operator: 'notIn', value: ['message'] },
        { field: 'priority', operator: '>=', value: 2 },
        { field: 'priority', operator: '<', value: 9 },
        { field: 'title', operator: 'contains', value: 'sync (retry)' },
        { field: 'source.key', operator: 'beginsWith', value: 'ADS-' },
        { field: 'labels', operator: 'contains', value: 'backend' },
        { field: 'dueAt', operator: 'within', value: 'this_week' },
        {
          combinator: 'or',
          not: true,
          rules: [
            { field: 'startAt', operator: 'between', value: ['2026-11-01T00:00:00Z', '@now'] },
            { field: 'closedAt', operator: 'notNull' },
          ],
        },
      ),
      sort: [
        { field: 'priority', dir: 'desc' },
        { field: 'title', dir: 'asc' },
      ],
    },
  ],
  [
    'vars, dynamic values and props',
    {
      source: 'items',
      where: where(
        { field: 'topic', operator: '=', value: '$page.topic' },
        { field: 'assignees', operator: 'contains', value: '@me' },
        { field: 'props.storyPoints', operator: '>', value: 1 },
        { field: 'overlay.pinned', operator: '=', value: false },
      ),
      dateRange: '$page.range',
      groupBy: ['containerId'],
    },
  ],
  [
    'aggregates',
    {
      source: 'items',
      groupBy: ['topic', 'status', 'source.provider'],
      aggregate: { op: 'sum', field: 'props.storyPoints' },
    },
  ],
  ['earliest', { source: 'items', groupBy: ['containerId'], aggregate: { op: 'earliest' } }],
  [
    'containers by type',
    {
      source: 'containers',
      containerType: 'course',
      where: where({ field: 'name', operator: 'contains', value: 'Calculus' }),
      groupBy: ['topic'],
    },
  ],
];

describe('compileQuery: base filter', () => {
  const narrowings = [undefined, ['college' as const]];
  for (const [name, query] of QUERIES) {
    for (const onlyTopics of narrowings) {
      for (const preview of [false, true]) {
        it(`${name} (onlyTopics ${JSON.stringify(onlyTopics)}, preview ${String(preview)}) starts with the base filter`, () => {
          const ctx = context({
            ws: onlyTopics === undefined ? { id: 'w-1' } : { id: 'w-1', onlyTopics },
            preview,
            vars: { topic: 'work', range: 'next_7d' },
          });
          const compiled = compileQuery(query, ctx);
          // H5: a block filtered by a provider other than `local` shows a provider copy, so its
          // base filter lacks the absorption rule; every other block has the full base filter.
          const filtersByProvider =
            query.source === 'items' &&
            JSON.stringify(compiled.pipeline).includes('source.provider');
          const base =
            query.source === 'items'
              ? baseItemFilter(ctx.ws, ctx.access)
              : baseContainerFilter(ctx.ws, ctx.access);
          const first = (compiled.pipeline[0]?.['$match'] ?? {}) as Record<string, unknown>;
          if (filtersByProvider && !('$nor' in first)) {
            assert.deepEqual(first, baseItemFilterUnabsorbed(ctx.ws, ctx.access));
          } else {
            assert.deepEqual(compiled.pipeline[0], { $match: base });
          }
          assert.equal(compiled.collection, query.source === 'items' ? 'Items' : 'Containers');
        });
      }
    }
  }

  it('sees its own and the shared integrations, shared to-dos and its own private ones', () => {
    const match = compileQuery({ source: 'items' }, context()).pipeline[0]?.['$match'];
    assert.deepEqual((match as Record<string, unknown>)['$or'], [
      { integrationId: { $in: ['i-own', 'i-shared'] } },
      { integrationId: null, ownerUserId: 'u-1' },
      { integrationId: null, visibility: 'workspace' },
    ]);
  });

  it('a calendar push (local: own) sees only its own integrations and its own to-dos', () => {
    const own = {
      userId: 'u-1',
      integrations: [{ id: 'i-own', provider: 'jira', accountId: 'site', ownerUserId: 'u-1' }],
      local: 'own',
    } as const;
    const match = compileQuery({ source: 'items' }, context({ access: own })).pipeline[0]?.[
      '$match'
    ];
    assert.deepEqual((match as Record<string, unknown>)['$or'], [
      { integrationId: { $in: ['i-own'] } },
      { integrationId: null, ownerUserId: 'u-1' },
    ]);
  });

  it('without a visible integration, only to-dos: no unshared integration leaks', () => {
    const none = { userId: 'u-1', integrations: [], local: 'visible' } as const;
    const items = compileQuery({ source: 'items' }, context({ access: none })).pipeline[0]?.[
      '$match'
    ] as Record<string, unknown>;
    assert.deepEqual(items['$or'], [
      { integrationId: null, ownerUserId: 'u-1' },
      { integrationId: null, visibility: 'workspace' },
    ]);
    const containers = compileQuery({ source: 'containers' }, context({ access: none }))
      .pipeline[0]?.['$match'] as Record<string, unknown>;
    assert.deepEqual(containers['integrationId'], { $in: [] });
  });

  it('containers come only from the integrations the caller may see', () => {
    const match = compileQuery({ source: 'containers' }, context()).pipeline[0]?.[
      '$match'
    ] as Record<string, unknown>;
    assert.deepEqual(match['integrationId'], { $in: ['i-own', 'i-shared'] });
  });

  it('adds the $in of an agent’s narrowing to some topics, never a member scope', () => {
    const scoped = compileQuery(
      { source: 'items' },
      context({ ws: { id: 'w-1', onlyTopics: ['college'] } }),
    ).pipeline[0]?.['$match'] as Record<string, unknown>;
    assert.deepEqual(scoped['topicId'], { $in: ['college'] });
    const containers = compileQuery(
      { source: 'containers' },
      context({ ws: { id: 'w-1', onlyTopics: ['college', 'work'] } }),
    ).pipeline[0]?.['$match'] as Record<string, unknown>;
    assert.deepEqual(containers['topicId'], { $in: ['college', 'work'] });
    const unscoped = compileQuery({ source: 'items' }, context()).pipeline[0]?.['$match'];
    assert.equal((unscoped as Record<string, unknown>)['topicId'], undefined);
  });

  it('a rule on the same field never replaces the base filter', () => {
    const compiled = compileQuery(
      { source: 'items', where: where({ field: 'topic', operator: '=', value: 'work' }) },
      context({ ws: { id: 'w-1', onlyTopics: ['college'] } }),
    );
    assert.deepEqual((compiled.pipeline[0]?.['$match'] as Record<string, unknown>)['topicId'], {
      $in: ['college'],
    });
    assert.deepEqual(filterOf(compiled), { topicId: 'work' });
  });
});

describe('compileQuery: effective values (a mirrored item’s overrides)', () => {
  it('projects every overridable field right after the base filter, for items only', () => {
    const compiled = compileQuery(
      { source: 'items', where: where({ field: 'status', operator: '=', value: 'done' }) },
      context(),
    );
    assert.ok('$match' in (compiled.pipeline[0] ?? {}), 'the access filter stays first');
    // Then a wider filter on what is stored (indexes narrow), then the effective values.
    assert.deepEqual(compiled.pipeline[1], {
      $match: { $or: [{ status: 'done' }, { 'overlay.overrides.status': { $ne: null } }] },
    });
    assert.deepEqual(compiled.pipeline[2], { $addFields: Overrides.projection() });
    // The filter, sort and groups come after it, so they read what the item reads as.
    assert.deepEqual(filterOf(compiled), { status: 'done' });
    const containers = compileQuery({ source: 'containers' }, context());
    assert.ok(!containers.pipeline.some((stage) => '$addFields' in stage));
  });
});

describe('compileQuery: no forbidden operator', () => {
  const forbidden = [
    '$where',
    '$function',
    '$accumulator',
    '$expr',
    '$lookup',
    '$graphLookup',
    '$unionWith',
    '$out',
    '$merge',
  ];

  for (const [name, query] of QUERIES) {
    it(name, () => {
      const compiled = compileQuery(query, context({ vars: { topic: 'work', range: 'today' } }));
      const keys = new Set(allKeys(compiled.pipeline));
      for (const operator of forbidden) assert.ok(!keys.has(operator), `${operator} in ${name}`);
    });
  }
});

describe('compileQuery: field whitelist', () => {
  it('refuses an unknown field', () => {
    rejects(
      { source: 'items', where: where({ field: 'secret', operator: '=', value: 'x' }) },
      '/where/rules/0/field',
    );
  });

  it('refuses fields outside the catalog, even real ones', () => {
    for (const field of ['ownerUserId', 'workspaceId', 'deletedAt', 'source.url', 'props', '_id']) {
      rejects(
        { source: 'items', where: where({ field, operator: 'null' }) },
        '/where/rules/0/field',
      );
    }
    rejects(
      { source: 'containers', where: where({ field: 'dueAt', operator: 'null' }) },
      '/where/rules/0/field',
    );
  });

  it('refuses credential, token, secret and prototype paths under props', () => {
    for (const field of [
      'props.token',
      'props.accessToken',
      'props.enc.ciphertext',
      'props.clientSecret',
      'props.password',
      'props.__proto__',
      'props.a.b.c.d.e',
      'props.$where',
      'props.x y',
    ]) {
      rejects(
        { source: 'items', where: where({ field, operator: 'null' }) },
        '/where/rules/0/field',
      );
    }
  });

  it('refuses an operator the field type does not take', () => {
    rejects(
      { source: 'items', where: where({ field: 'status', operator: 'contains', value: 'op' }) },
      '/where/rules/0/operator',
    );
    rejects(
      { source: 'items', where: where({ field: 'labels', operator: '=', value: 'x' }) },
      '/where/rules/0/operator',
    );
    rejects(
      { source: 'items', where: where({ field: 'priority', operator: 'within', value: 'today' }) },
      '/where/rules/0/operator',
    );
  });

  it('refuses values of the wrong type, without echoing them', () => {
    const error = rejects(
      {
        source: 'items',
        where: where({ field: 'status', operator: '=', value: 'pk_live_FAKE0123456789abcdef' }),
      },
      '/where/rules/0/value',
    );
    assert.doesNotMatch(error.message, /pk_live/);
    rejects(
      { source: 'items', where: where({ field: 'priority', operator: '>', value: 'high' }) },
      '/where/rules/0/value',
    );
    rejects(
      { source: 'items', where: where({ field: 'dueAt', operator: '<', value: 'yesterday' }) },
      '/where/rules/0/value',
    );
    rejects(
      { source: 'items', where: where({ field: 'allDay', operator: '=', value: 'yes' }) },
      '/where/rules/0/value',
    );
    rejects(
      {
        source: 'items',
        where: where({ field: 'kind', operator: 'in', value: ['event', 'bogus'] }),
      },
      '/where/rules/0/value/1',
    );
    rejects(
      { source: 'items', where: where({ field: 'title', operator: '=' }) },
      '/where/rules/0/value',
    );
  });

  it('refuses unknown or list fields in groupBy, sort and aggregate', () => {
    rejects({ source: 'items', groupBy: ['topic', 'secret'] }, '/groupBy/1');
    rejects({ source: 'items', groupBy: ['labels'] }, '/groupBy/0');
    rejects({ source: 'items', sort: [{ field: 'password', dir: 'asc' }] }, '/sort/0/field');
    rejects({ source: 'items', aggregate: { op: 'sum', field: 'title' } }, '/aggregate/field');
    rejects({ source: 'items', aggregate: { op: 'max' } }, '/aggregate');
    rejects({ source: 'items', aggregate: { op: 'count', field: 'priority' } }, '/aggregate/field');
    rejects({ source: 'containers', aggregate: { op: 'earliest' } }, '/aggregate');
  });

  it('refuses a query that fails the shared schema, with its pointer', () => {
    rejects(
      { source: 'items', where: where({ field: 'status', operator: 'like', value: 'x' }) },
      '/where/rules/0/operator',
    );
    rejects({ source: 'items', limit: 500 }, '/limit');
    rejects({ source: 'users' }, '/source');
  });
});

describe('compileQuery: operator smuggling', () => {
  it('refuses a $where object in a value', () => {
    rejects(
      {
        source: 'items',
        where: where({ field: 'title', operator: '=', value: { $where: 'sleep(10000)' } }),
      },
      '/where/rules/0/value/$where',
    );
  });

  it('refuses $-keys at any depth of the query', () => {
    rejects(
      {
        source: 'items',
        where: where({ field: 'labels', operator: 'in', value: [{ $function: {} }] }),
      },
      '/where/rules/0/value/0/$function',
    );
    rejects(
      { source: 'items', dateRange: { from: { $expr: 1 }, to: 'x' } },
      '/dateRange/from/$expr',
    );
    rejects({ source: 'items', $where: 'true' }, '/$where');
    rejects(
      { source: 'items', where: { combinator: 'and', rules: [], $accumulator: {} } },
      '/where/$accumulator',
    );
  });

  it('refuses a variable whose value carries a $-key', () => {
    const query: Query = {
      source: 'items',
      where: where({ field: 'topic', operator: '=', value: '$page.topic' }),
    };
    rejects(query, '/where/rules/0/value/$ne', context({ vars: { topic: { $ne: null } } }));
    rejects(
      query,
      '/where/rules/0/value/0/$gt',
      context({ vars: { '$page.topic': [{ $gt: '' }] } }),
    );
  });

  it('refuses absurdly deep input before parsing it', () => {
    let value: unknown = 'x';
    for (let depth = 0; depth < 200; depth += 1) value = [value];
    assert.throws(
      () =>
        compileQuery(
          { source: 'items', where: where({ field: 'title', operator: '=', value }) },
          context(),
        ),
      (error: unknown) =>
        error instanceof QueryValidationError &&
        error.pointer.startsWith('/where/rules/0/value/0/0/0') &&
        error.reason.includes('deep'),
    );
  });

  it('escapes contains and beginsWith into literal regexes, and caps them at 100 characters', () => {
    const compiled = compileQuery(
      {
        source: 'items',
        where: where(
          { field: 'title', operator: 'contains', value: 'a.b*(c)?[d]+{e}|^f$\\' },
          { field: 'source.key', operator: 'beginsWith', value: 'ADS-1' },
        ),
      },
      context(),
    );
    assert.deepEqual(filterOf(compiled), {
      $and: [
        { title: { $regex: 'a\\.b\\*\\(c\\)\\?\\[d\\]\\+\\{e\\}\\|\\^f\\$\\\\', $options: 'i' } },
        { 'source.key': { $regex: '^ADS-1', $options: 'i' } },
      ],
    });
    compileQuery(
      {
        source: 'items',
        where: where({
          field: 'title',
          operator: 'contains',
          value: 'x'.repeat(CAPS.maxRegexLength),
        }),
      },
      context(),
    );
    const error = rejects(
      {
        source: 'items',
        where: where({ field: 'title', operator: 'contains', value: 'x'.repeat(101) }),
      },
      '/where/rules/0/value',
    );
    assert.match(error.reason, /100/);
    rejects(
      { source: 'items', where: where({ field: 'title', operator: 'contains', value: '$page.q' }) },
      '/where/rules/0/value',
      context({ vars: { q: 'y'.repeat(101) } }),
    );
  });
});

describe('compileQuery: variables and dynamic values', () => {
  const byArea: Query = {
    source: 'items',
    where: where(
      { field: 'topic', operator: '=', value: '$page.topic' },
      { field: 'status', operator: 'in', value: ['open', 'in_progress'] },
    ),
  };

  it('drops a rule whose variable is unset, with a warning', () => {
    for (const vars of [{}, { topic: null }, { topic: '' }, { topic: [] }, { constructor: 'x' }]) {
      const compiled = compileQuery(byArea, context({ vars }));
      assert.deepEqual(filterOf(compiled), { status: { $in: ['open', 'in_progress'] } });
      assert.equal(compiled.warnings.length, 1);
      assert.match(compiled.warnings[0] ?? '', /\$page\.topic/);
      assert.match(compiled.warnings[0] ?? '', /\/where\/rules\/0/);
      assert.deepEqual(compiled.appliedVars, {});
    }
  });

  it('applies a set variable, keyed $page.<name> or by bare name, and reports it', () => {
    for (const vars of [{ topic: 'work' }, { '$page.topic': 'work' }]) {
      const compiled = compileQuery(byArea, context({ vars }));
      assert.deepEqual(filterOf(compiled), {
        $and: [{ topicId: 'work' }, { status: { $in: ['open', 'in_progress'] } }],
      });
      assert.deepEqual(compiled.appliedVars, { '$page.topic': 'work' });
      assert.deepEqual(compiled.warnings, []);
    }
  });

  it('never reads a variable from the object prototype', () => {
    const query: Query = {
      source: 'items',
      where: where({ field: 'title', operator: '=', value: '$page.constructor' }),
    };
    const compiled = compileQuery(query, context());
    assert.equal(filterOf(compiled), undefined);
    assert.equal(compiled.warnings.length, 1);
  });

  it('a variable that empties a whole group drops the group', () => {
    const compiled = compileQuery(
      {
        source: 'items',
        where: where({
          combinator: 'or',
          rules: [{ field: 'containerId', operator: '=', value: '$page.course' }],
        }),
      },
      context(),
    );
    assert.equal(filterOf(compiled), undefined);
    // The base filter, the effective values, the facet.
    assert.equal(compiled.pipeline.length, 3);
  });

  it('resolves @me to the caller, @now to now and @today to local midnight', () => {
    const compiled = compileQuery(
      {
        source: 'items',
        where: where(
          { field: 'assignees', operator: 'contains', value: '@me' },
          { field: 'dueAt', operator: '<', value: '@now' },
          { field: 'startAt', operator: '>=', value: '@today' },
          { field: 'labels', operator: 'in', value: ['@me', 'team'] },
        ),
      },
      context(),
    );
    assert.deepEqual(filterOf(compiled), {
      $and: [
        { assignees: 'u-1' },
        { dueAt: { $lt: NOW } },
        { startAt: { $gte: new Date('2026-11-10T22:00:00Z') } },
        { labels: { $in: ['u-1', 'team'] } },
      ],
    });
  });

  it('a variable can hold a preset or a {from, to} range for within and dateRange', () => {
    const query: Query = {
      source: 'items',
      where: where({ field: 'dueAt', operator: 'within', value: '$page.when' }),
      dateRange: '$page.range',
    };
    const compiled = compileQuery(
      query,
      context({
        vars: {
          when: 'today',
          range: { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' },
        },
      }),
    );
    assert.deepEqual(filterOf(compiled), {
      $and: [
        {
          dueAt: { $gte: new Date('2026-11-10T22:00:00Z'), $lt: new Date('2026-11-11T22:00:00Z') },
        },
        {
          dueAt: { $gte: new Date('2026-11-01T00:00:00Z'), $lt: new Date('2026-12-01T00:00:00Z') },
        },
      ],
    });
    assert.deepEqual(Object.keys(compiled.appliedVars), ['$page.when', '$page.range']);
    rejects(query, '/where/rules/0/value', context({ vars: { when: 'someday' } }));
  });

  it('an unset dateRange variable drops the range, with a warning', () => {
    const compiled = compileQuery({ source: 'items', dateRange: '$page.range' }, context());
    assert.equal(filterOf(compiled), undefined);
    assert.match(compiled.warnings[0] ?? '', /\$page\.range/);
  });
});

describe('compileQuery: filters', () => {
  it('applies dateRange to dateField: dueAt by default, any for calendars, startAt for clocks', () => {
    const today = { $gte: new Date('2026-11-10T22:00:00Z'), $lt: new Date('2026-11-11T22:00:00Z') };
    assert.deepEqual(filterOf(compileQuery({ source: 'items', dateRange: 'today' }, context())), {
      dueAt: today,
    });
    assert.deepEqual(
      filterOf(
        compileQuery({ source: 'items', dateRange: 'today' }, context({ blockType: 'calendar' })),
      ),
      { $or: [{ startAt: today }, { startAt: null, dueAt: today }] },
    );
    assert.deepEqual(
      filterOf(
        compileQuery({ source: 'items', dateRange: 'today' }, context({ blockType: 'clock' })),
      ),
      { startAt: today },
    );
    assert.deepEqual(
      filterOf(
        compileQuery(
          { source: 'items', dateRange: 'today', dateField: 'dueAt' },
          context({ blockType: 'clock' }),
        ),
      ),
      { dueAt: today },
    );
    assert.deepEqual(
      filterOf(
        compileQuery(
          {
            source: 'items',
            dateRange: { from: '2026-11-01T00:00:00+02:00', to: '2026-11-02T00:00:00+02:00' },
          },
          context(),
        ),
      ),
      { dueAt: { $gte: new Date('2026-10-31T22:00:00Z'), $lt: new Date('2026-11-01T22:00:00Z') } },
    );
  });

  it("dateField 'any': a start in range, or no start and a due date in range", () => {
    const week = { $gte: new Date('2026-11-07T22:00:00Z'), $lt: new Date('2026-11-14T22:00:00Z') };
    const anyInWeek = { $or: [{ startAt: week }, { startAt: null, dueAt: week }] };
    const query: Query = { source: 'items', dateRange: 'this_week', dateField: 'any' };
    // An explicit dateField wins over every block type's default.
    for (const blockType of [undefined, 'calendar', 'clock', 'deadlines'] as const) {
      const ctx = blockType === undefined ? context() : context({ blockType });
      assert.deepEqual(filterOf(compileQuery(query, ctx)), anyInWeek);
    }
    // With other filters it joins the $and; a variable range resolves the same way.
    const compiled = compileQuery(
      {
        source: 'items',
        where: where({ field: 'kind', operator: '=', value: 'event' }),
        dateRange: '$page.range',
        dateField: 'any',
      },
      context({ vars: { range: 'this_week' } }),
    );
    assert.deepEqual(filterOf(compiled), { $and: [{ kind: 'event' }, anyInWeek] });
    // An unset range variable drops the whole date filter, as for the other date fields.
    const unset = compileQuery(
      { source: 'items', dateRange: '$page.range', dateField: 'any' },
      context(),
    );
    assert.equal(filterOf(unset), undefined);
    assert.match(unset.warnings[0] ?? '', /\$page\.range/);
  });

  it("dateField 'any' is for items only, like the other date fields", () => {
    rejects({ source: 'containers', dateRange: 'today', dateField: 'any' }, '/dateRange');
  });

  it('compiles nesting, not, null checks and booleans', () => {
    const compiled = compileQuery(
      {
        source: 'items',
        where: {
          combinator: 'or',
          not: true,
          rules: [
            { field: 'dueAt', operator: 'null' },
            { field: 'labels', operator: 'notNull' },
            {
              combinator: 'and',
              rules: [
                { field: 'overlay.hidden', operator: '=', value: true },
                { field: 'allDay', operator: '!=', value: true },
              ],
            },
          ],
        },
      },
      context(),
    );
    assert.deepEqual(filterOf(compiled), {
      $nor: [
        {
          $or: [
            { dueAt: null },
            { labels: { $nin: [null, []] } },
            { $and: [{ 'overlay.hidden': true }, { allDay: { $ne: true } }] },
          ],
        },
      ],
    });
  });

  it('treats a missing boolean as false', () => {
    const pinned = (operator: '=' | '!=', value: boolean): unknown =>
      filterOf(
        compileQuery(
          { source: 'items', where: where({ field: 'overlay.pinned', operator, value }) },
          context(),
        ),
      );
    assert.deepEqual(pinned('=', true), { 'overlay.pinned': true });
    assert.deepEqual(pinned('=', false), { 'overlay.pinned': { $ne: true } });
    assert.deepEqual(pinned('!=', true), { 'overlay.pinned': { $ne: true } });
    assert.deepEqual(pinned('!=', false), { 'overlay.pinned': true });
  });

  it('between takes two dates, inclusive; in takes a list (or one value)', () => {
    assert.deepEqual(
      filterOf(
        compileQuery(
          {
            source: 'items',
            where: where({
              field: 'dueAt',
              operator: 'between',
              value: ['2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'],
            }),
          },
          context(),
        ),
      ),
      { dueAt: { $gte: new Date('2026-11-01T00:00:00Z'), $lte: new Date('2026-11-30T00:00:00Z') } },
    );
    rejects(
      {
        source: 'items',
        where: where({
          field: 'dueAt',
          operator: 'between',
          value: ['2026-11-30T00:00:00Z', '2026-11-01T00:00:00Z'],
        }),
      },
      '/where/rules/0/value',
    );
    rejects(
      {
        source: 'items',
        where: where({ field: 'dueAt', operator: 'between', value: ['2026-11-30T00:00:00Z'] }),
      },
      '/where/rules/0/value',
    );
    assert.deepEqual(
      filterOf(
        compileQuery(
          {
            source: 'items',
            where: where({ field: 'topic', operator: 'in', value: '$page.areas' }),
          },
          context({ vars: { areas: 'work' } }),
        ),
      ),
      { topicId: { $in: ['work'] } },
    );
    rejects(
      { source: 'items', where: where({ field: 'topic', operator: 'in', value: [] }) },
      '/where/rules/0/value',
    );
  });

  it('narrows containers by type', () => {
    assert.deepEqual(
      filterOf(compileQuery({ source: 'containers', containerType: 'course' }, context())),
      { type: 'course' },
    );
  });
});

describe('compileQuery: block connectors (PERMISSIONS-V2)', () => {
  it('reads only the block’s connectors, after the base filter', () => {
    const compiled = compileQuery({ source: 'items' }, context({ connectors: ['i-own'] }));
    assert.deepEqual(filterOf(compiled), { integrationId: { $in: ['i-own'] } });
    assert.ok('$or' in (compiled.pipeline[0]?.['$match'] as Record<string, unknown>));
  });

  it('`local` adds local to-dos; alone it reads only them', () => {
    const both = compileQuery({ source: 'items' }, context({ connectors: ['i-own', 'local'] }));
    assert.deepEqual(filterOf(both), {
      $or: [{ integrationId: { $in: ['i-own'] } }, { integrationId: null }],
    });
    const local = compileQuery({ source: 'items' }, context({ connectors: ['local'] }));
    assert.deepEqual(filterOf(local), { integrationId: null });
  });

  it('containers have no local to-dos: a local-only block reads no container', () => {
    const local = compileQuery({ source: 'containers' }, context({ connectors: ['local'] }));
    assert.deepEqual(filterOf(local), { integrationId: { $in: [] } });
    const mixed = compileQuery(
      { source: 'containers' },
      context({ connectors: ['i-own', 'local'] }),
    );
    assert.deepEqual(filterOf(mixed), { integrationId: { $in: ['i-own'] } });
  });

  it('no connectors field: everything the caller may see; an empty list: nothing (M3)', () => {
    assert.equal(filterOf(compileQuery({ source: 'items' }, context())), undefined);
    for (const source of ['items', 'containers'] as const) {
      assert.deepEqual(filterOf(compileQuery({ source }, context({ connectors: [] }))), {
        integrationId: { $in: [] },
      });
    }
  });

  it('a connector scope reads only the containers it names (plan Addendum A4)', () => {
    const scoped = compileQuery(
      { source: 'items' },
      context({
        connectors: ['i-own', 'i-shared', 'local'],
        connectorScopes: { 'i-shared': ['cal-1', 'cal-2'], 'i-gone': ['x'] },
        scopeContainerIds: { 'i-shared': ['c-1'] },
      }),
    );
    assert.deepEqual(filterOf(scoped), {
      $or: [
        { integrationId: { $in: ['i-own'] } },
        {
          integrationId: 'i-shared',
          $or: [
            {
              'source.provider': 'google_calendar',
              'props.calendarId': { $in: ['cal-1', 'cal-2'] },
            },
            { containerId: { $in: ['c-1'] } },
          ],
        },
        { integrationId: null },
      ],
    });
    // Containers: by their own external id. A scope without its connector changes nothing.
    const containers = compileQuery(
      { source: 'containers' },
      context({ connectors: ['i-shared'], connectorScopes: { 'i-shared': ['cal-1'] } }),
    );
    assert.deepEqual(filterOf(containers), {
      integrationId: 'i-shared',
      'source.externalId': { $in: ['cal-1'] },
    });
    const unscoped = compileQuery(
      { source: 'items' },
      context({ connectors: ['i-own'], connectorScopes: { 'i-shared': ['cal-1'] } }),
    );
    assert.deepEqual(filterOf(unscoped), { integrationId: { $in: ['i-own'] } });
    // No connectors field: every source, scopes or not.
    assert.equal(
      filterOf(compileQuery({ source: 'items' }, context({ connectorScopes: { 'i-own': ['a'] } }))),
      undefined,
    );
  });

  it('dedup keeps one copy per provider, account and external id, the first in order', () => {
    const compiled = compileQuery(
      { source: 'items' },
      context({ connectors: ['i-own', 'i-shared'], dedup: ['i-own', 'i-shared'] }),
    );
    const stages = compiled.pipeline.map((stage) => Object.keys(stage)[0]);
    assert.deepEqual(stages, [
      '$match',
      '$addFields',
      '$match',
      '$addFields',
      '$sort',
      '$group',
      '$replaceRoot',
      '$facet',
    ]);
    const group = compiled.pipeline[5]?.['$group'] as Record<string, unknown>;
    assert.deepEqual(group['doc'], { $first: '$$ROOT' });
    assert.match(JSON.stringify(group['_id']), /source\.accountId/);
    // Not for containers, and not with fewer than two integrations to choose from.
    const containers = compileQuery(
      { source: 'containers' },
      context({ dedup: ['i-own', 'i-shared'] }),
    );
    assert.ok(!JSON.stringify(containers.pipeline).includes('$group'));
    const single = compileQuery({ source: 'items' }, context({ dedup: ['i-own'] }));
    assert.ok(!JSON.stringify(single.pipeline).includes('$replaceRoot'));
  });
});

describe('compileQuery: connectors', () => {
  it('limits a block to connectors with a plain integrationId in rule, for items and containers', () => {
    const ids = ['int-clickup', 'int-jira'];
    for (const source of ['items', 'containers'] as const) {
      const compiled = compileQuery(
        { source, where: where({ field: 'integrationId', operator: 'in', value: ids }) },
        context(),
      );
      assert.deepEqual(JSON.stringify(compiled.pipeline).includes('"integrationId":{"$in"'), true);
      assert.ok(JSON.stringify(compiled.pipeline).includes('int-jira'));
    }
  });
});

describe('compileQuery: rows', () => {
  it('sorts by dueAt ascending, nulls last, then _id, and keeps 50 rows by default', () => {
    const rows = facetOf(compileQuery({ source: 'items' }, context()))['rows'];
    assert.deepEqual(stage(rows, '$addFields'), {
      __null0: { $cond: [{ $eq: [{ $ifNull: ['$dueAt', null] }, null] }, 1, 0] },
    });
    assert.deepEqual(Object.entries(stage(rows, '$sort') as object), [
      ['__null0', 1],
      ['dueAt', 1],
      ['_id', 1],
    ]);
    assert.equal(stage(rows, '$limit'), 50);
  });

  it('sorts status by its workflow rank (open, in_progress, done, cancelled), not alphabetically', () => {
    const rows = facetOf(
      compileQuery({ source: 'items', sort: [{ field: 'status', dir: 'asc' }] }, context()),
    )['rows'];
    const added = stage(rows, '$addFields') as Record<string, unknown>;
    assert.deepEqual(Object.keys(added).sort(), ['__null0', '__rank0']);
    assert.deepEqual(added['__rank0'], {
      $switch: {
        branches: [
          { case: { $eq: ['$status', 'open'] }, then: 0 },
          { case: { $eq: ['$status', 'in_progress'] }, then: 1 },
          { case: { $eq: ['$status', 'done'] }, then: 2 },
          { case: { $eq: ['$status', 'cancelled'] }, then: 3 },
        ],
        default: 4,
      },
    });
    assert.deepEqual(Object.entries(stage(rows, '$sort') as object), [
      ['__null0', 1],
      ['__rank0', 1],
      ['_id', 1],
    ]);
    const desc = facetOf(
      compileQuery({ source: 'items', sort: [{ field: 'status', dir: 'desc' }] }, context()),
    )['rows'];
    assert.equal((stage(desc, '$sort') as Record<string, number>)['__rank0'], -1);
  });

  it('sorts priority numerically: higher means more important, so desc puts urgent first', () => {
    const rows = facetOf(
      compileQuery({ source: 'items', sort: [{ field: 'priority', dir: 'desc' }] }, context()),
    )['rows'];
    assert.deepEqual(Object.entries(stage(rows, '$sort') as object), [
      ['__null0', 1],
      ['priority', -1],
      ['_id', 1],
    ]);
  });

  it('caps the limit at 200, and at 20 rows in preview', () => {
    const limit = (query: Query, preview: boolean): unknown =>
      stage(facetOf(compileQuery(query, context({ preview })))['rows'], '$limit');
    assert.equal(limit({ source: 'items', limit: 200 }, false), 200);
    assert.equal(limit({ source: 'items', limit: 200 }, true), CAPS.previewRows);
    assert.equal(limit({ source: 'items', limit: 5 }, true), 5);
    assert.equal(limit({ source: 'items' }, true), CAPS.previewRows);
  });

  it('projects the row fields, source.url included, and nothing else', () => {
    const rows = facetOf(compileQuery({ source: 'items' }, context()))['rows'];
    assert.deepEqual(
      Object.keys(stage(rows, '$project') as object).sort(),
      [
        'allDay',
        'assignees',
        'closedAt',
        'containerId',
        'dueAt',
        'endAt',
        'importance',
        'kind',
        'labels',
        'overlay',
        'priority',
        'props',
        'source.externalId',
        'source.key',
        'source.provider',
        'source.url',
        'startAt',
        'status',
        'statusRaw',
        'title',
        'topicId',
      ].sort(),
    );
    const containerRows = facetOf(compileQuery({ source: 'containers' }, context()))['rows'];
    assert.ok(Object.keys(stage(containerRows, '$project') as object).includes('source.url'));
  });

  it('counts the total over the same match', () => {
    const facet = facetOf(compileQuery({ source: 'items' }, context()));
    assert.deepEqual(facet['total'], [{ $count: 'count' }]);
    assert.equal(facet['groups'], undefined);
  });
});

describe('compileQuery: groups', () => {
  it('groups by up to 3 fields with a count', () => {
    const compiled = compileQuery(
      { source: 'items', groupBy: ['source.provider'], aggregate: { op: 'count' } },
      context(),
    );
    const facet = facetOf(compiled);
    assert.deepEqual(stage(facet['groups'], '$group'), {
      _id: { k0: '$source.provider' },
      value: { $sum: 1 },
    });
    assert.equal(facet['rows'], undefined);
    assert.deepEqual(compiled.groupBy, ['source.provider']);
  });

  it('sums, takes min/max, and earliest = the min of dueAt', () => {
    const group = (query: Query): unknown =>
      stage(facetOf(compileQuery(query, context()))['groups'], '$group');
    assert.deepEqual(
      group({ source: 'items', groupBy: ['topic'], aggregate: { op: 'sum', field: 'priority' } }),
      {
        _id: { k0: '$topicId' },
        value: { $sum: '$priority' },
      },
    );
    assert.deepEqual(
      group({ source: 'items', groupBy: ['topic'], aggregate: { op: 'max', field: 'dueAt' } }),
      {
        _id: { k0: '$topicId' },
        value: { $max: '$dueAt' },
      },
    );
    assert.deepEqual(
      group({
        source: 'items',
        groupBy: ['topic', 'kind'],
        aggregate: { op: 'min', field: 'props.points' },
      }),
      {
        _id: { k0: '$topicId', k1: '$kind' },
        value: { $min: '$props.points' },
      },
    );
    assert.deepEqual(
      group({ source: 'items', groupBy: ['containerId'], aggregate: { op: 'earliest' } }),
      {
        _id: { k0: '$containerId' },
        value: { $min: '$dueAt' },
      },
    );
  });

  it('an aggregate without groupBy is one group', () => {
    const facet = facetOf(compileQuery({ source: 'items', aggregate: { op: 'count' } }, context()));
    assert.deepEqual(stage(facet['groups'], '$group'), { _id: null, value: { $sum: 1 } });
  });

  it('a groupBy without an aggregate returns rows and a count per group (kanban)', () => {
    const facet = facetOf(compileQuery({ source: 'items', groupBy: ['status'] }, context()));
    assert.ok(facet['rows']);
    assert.deepEqual(stage(facet['groups'], '$group'), {
      _id: { k0: '$status' },
      value: { $sum: 1 },
    });
  });

  it('caps groups at 20 in preview', () => {
    const facet = facetOf(
      compileQuery(
        { source: 'items', groupBy: ['containerId'], aggregate: { op: 'count' } },
        context({ preview: true }),
      ),
    );
    assert.equal(stage(facet['groups'], '$limit'), CAPS.previewRows);
  });
});

describe('parseQuery', () => {
  it('validates stored JSON into a query', () => {
    assert.deepEqual(parseQuery({ source: 'items', limit: 5 }), { source: 'items', limit: 5 });
    assert.throws(() => parseQuery({ source: 'items', extra: true }), QueryValidationError);
    assert.throws(() => parseQuery(null), QueryValidationError);
  });
});
