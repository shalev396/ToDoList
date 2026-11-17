/**
 * Date attributes are days stored at noon UTC (H4 fix): `on`, `inLast` and `inNext` count whole
 * local days, so they match the right day in zones west and east of UTC. Run on a real mongod
 * through the compiled pipeline.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as MongooseNs from 'mongoose';

import { startMemoryMongo, type MemoryMongo } from '../testing/memoryMongo.js';
import { AttributeDefinition } from '../classes/workspace/AttributeDefinition.js';
import { dayOf, noonOf, type AttributeDef } from '../types/attributes.js';
import type { Query } from '../types/builder.js';
import { compileQuery } from './compile.js';

const DUE: AttributeDef = { key: 'review', name: 'Review', type: 'date', builtIn: false };
const DAYS = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'];

describe('normalising a date attribute value', () => {
  it('accepts a day or an ISO date-time and keeps the day written', () => {
    assert.equal(dayOf('2026-12-01'), '2026-12-01');
    assert.equal(dayOf('2026-12-01T00:00:00Z'), '2026-12-01');
    assert.equal(dayOf('2026-12-01T23:30:00+03:00'), '2026-12-01');
    assert.equal(dayOf('2026-02-30'), null);
    assert.equal(dayOf('tomorrow'), null);
    assert.equal(noonOf('2026-12-01').toISOString(), '2026-12-01T12:00:00.000Z');
    assert.equal(AttributeDefinition.of(DUE).check('2026-12-01'), null);
    assert.equal(AttributeDefinition.of(DUE).check('2026-12-01T00:00:00Z'), null);
    assert.notEqual(AttributeDefinition.of(DUE).check('soon'), null);
  });
});

describe('date attributes in zones either side of UTC', () => {
  let mongo: MemoryMongo;
  let mongoose: typeof MongooseNs.default;
  const collection = (): ReturnType<typeof mongoose.connection.collection> =>
    mongoose.connection.collection('date_attr');

  before(async () => {
    mongo = await startMemoryMongo('todolist_date_attr_test');
    mongoose = (await import('mongoose')).default;
    await mongoose.connect(mongo.uri);
    await collection().insertMany(
      DAYS.map((day) => ({
        _id: day as never,
        workspaceId: 'w',
        deletedAt: null,
        visibility: 'workspace',
        overlay: { attrs: { review: noonOf(day) } },
      })),
    );
  });

  after(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  async function found(timeZone: string, now: string, rule: object): Promise<string[]> {
    const query = { source: 'items', where: { combinator: 'and', rules: [rule] } } as Query;
    const { pipeline } = compileQuery(query, {
      ws: { id: 'w' },
      userId: 'u',
      access: { userId: 'u', integrations: [], local: 'visible' },
      vars: {},
      now: new Date(now),
      timeZone,
      weekStart: 'sun',
      preview: false,
      attributes: [DUE],
    });
    const [facet] = await collection().aggregate(pipeline).toArray();
    return ((facet?.['rows'] ?? []) as { _id?: string }[]).map((row) => String(row._id)).sort();
  }

  // 2026-11-11T03:00Z is Nov 10, 22:00 in New York and Nov 11, 05:00 in Jerusalem.
  const NOW = '2026-11-11T03:00:00Z';

  it('America/New_York: today is Nov 10', async () => {
    const zone = 'America/New_York';
    assert.deepEqual(
      await found(zone, NOW, {
        field: 'attr.review',
        operator: 'on',
        value: '2026-11-10' + 'T12:00:00Z',
      }),
      ['2026-11-10'],
    );
    assert.deepEqual(
      await found(zone, NOW, { field: 'attr.review', operator: 'inLast', value: [1, 'days'] }),
      ['2026-11-09', '2026-11-10'],
    );
    assert.deepEqual(
      await found(zone, NOW, { field: 'attr.review', operator: 'inNext', value: [1, 'days'] }),
      ['2026-11-10', '2026-11-11'],
    );
  });

  it('Asia/Jerusalem: today is Nov 11', async () => {
    const zone = 'Asia/Jerusalem';
    assert.deepEqual(
      await found(zone, NOW, {
        field: 'attr.review',
        operator: 'on',
        value: '2026-11-11T12:00:00Z',
      }),
      ['2026-11-11'],
    );
    assert.deepEqual(
      await found(zone, NOW, { field: 'attr.review', operator: 'inLast', value: [1, 'days'] }),
      ['2026-11-10', '2026-11-11'],
    );
    assert.deepEqual(
      await found(zone, NOW, { field: 'attr.review', operator: 'inNext', value: [1, 'days'] }),
      ['2026-11-11', '2026-11-12'],
    );
  });
});
