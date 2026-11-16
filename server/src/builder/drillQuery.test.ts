import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Query, Rule } from '../types/builder.js';
import { compileQuery, type CompileContext } from './compile.js';

/** The shape the client's chart drill sends (client `drillQuery`): typed rule value, a sort the source has. */
const CONTEXT: CompileContext = {
  ws: { id: 'w-1' },
  userId: 'u-1',
  access: { userId: 'u-1', integrations: [], local: 'visible' },
  vars: {},
  now: new Date('2026-11-11T08:00:00Z'),
  timeZone: 'Asia/Jerusalem',
  weekStart: 'sun',
  preview: true,
};

function drill(
  source: Query['source'],
  field: string,
  value: Rule['value'],
  sortField: string,
): Query {
  return {
    source,
    where: { combinator: 'and', rules: [{ field, operator: '=', value }] },
    sort: [{ field: sortField, dir: 'asc' }],
    limit: 20,
  };
}

describe('chart drill queries compile', () => {
  it('accepts a numeric priority and a boolean allDay', () => {
    assert.doesNotThrow(() => compileQuery(drill('items', 'priority', 2, 'dueAt'), CONTEXT));
    assert.doesNotThrow(() => compileQuery(drill('items', 'allDay', true, 'dueAt'), CONTEXT));
  });

  it('refuses the display strings the client used to send', () => {
    assert.throws(() => compileQuery(drill('items', 'priority', '2', 'dueAt'), CONTEXT));
    assert.throws(() => compileQuery(drill('items', 'allDay', 'true', 'dueAt'), CONTEXT));
  });

  it('accepts a container drill sorted by name and refuses dueAt there', () => {
    assert.doesNotThrow(() =>
      compileQuery(drill('containers', 'type', 'project', 'name'), CONTEXT),
    );
    assert.throws(() => compileQuery(drill('containers', 'type', 'project', 'dueAt'), CONTEXT));
  });
});
