/**
 * Importance scoring (H4): each preset's formula, the HRRN no-starvation property, and parity of
 * the Mongo expression with the reference scorer on a real (throwaway) mongod.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as MongooseNs from 'mongoose';

import { BUILTIN_IMPORTANCE, type AttributeDef } from '../types/attributes.js';
import type { ImportanceConfig } from '../types/importance.js';
import { startMemoryMongo, type MemoryMongo } from '../testing/memoryMongo.js';
import {
  dueSoon,
  importanceFields,
  responseRatio,
  scoreItem,
  sizeOf,
  weightedTerms,
  type ScoredItem,
} from './importance.js';

const NOW = new Date('2026-11-11T08:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const days = (n: number): Date => new Date(NOW.getTime() + n * DAY);

const STARS: AttributeDef = { key: 'stars', name: 'Stars', type: 'rating', builtIn: false };
const COST: AttributeDef = {
  key: 'cost',
  name: 'Cost',
  type: 'number',
  min: 0,
  max: 50,
  builtIn: false,
};
const ATTRIBUTES = [BUILTIN_IMPORTANCE, STARS, COST];

function item(overrides: Partial<ScoredItem> = {}): ScoredItem {
  return {
    priority: null,
    dueAt: null,
    startAt: null,
    createdAt: NOW,
    pinned: false,
    attrs: {},
    props: {},
    ...overrides,
  };
}

const weighted = (weights?: Record<string, number>): ImportanceConfig => ({
  preset: 'weighted',
  params: weights === undefined ? {} : { weights },
});
const FAIR: ImportanceConfig = { preset: 'fair', params: {} };
const SHORTEST: ImportanceConfig = { preset: 'shortest', params: {} };
const DEADLINE: ImportanceConfig = { preset: 'deadline', params: {} };

const score = (config: ImportanceConfig, it_: ScoredItem): number =>
  scoreItem(config, ATTRIBUTES, it_, NOW);

describe('due soon', () => {
  it('ramps from 0 at 14 days out to 1 at due', () => {
    assert.equal(dueSoon(null, NOW), 0);
    assert.equal(dueSoon(days(30), NOW), 0);
    assert.equal(dueSoon(days(14), NOW), 0);
    assert.equal(dueSoon(days(7), NOW), 0.5);
    assert.equal(dueSoon(days(0), NOW), 1);
  });

  it('stays 1 while overdue up to 7 days, then decays to 0.5', () => {
    assert.equal(dueSoon(days(-3), NOW), 1);
    assert.equal(dueSoon(days(-7), NOW), 1);
    assert.equal(dueSoon(days(-10.5), NOW), 0.75);
    assert.equal(dueSoon(days(-14), NOW), 0.5);
    assert.equal(dueSoon(days(-400), NOW), 0.5);
  });
});

describe('weighted', () => {
  it('uses the default weights: priority 3, due soon 4, importance 3, pinned 1', () => {
    const terms = weightedTerms(weighted(), ATTRIBUTES).terms;
    assert.deepEqual(
      terms.map((term) => [term.factor, term.weight]),
      [
        ['priority', 3],
        ['dueSoon', 4],
        ['importance', 3],
        ['pinned', 1],
      ],
    );
  });

  it('an empty item scores from the Importance default (3 of 5 = 0.5): 3 * 0.5 / 11', () => {
    assert.equal(score(weighted(), item()), Math.round((100 * 1.5) / 11));
  });

  it('a perfect item scores 100', () => {
    const best = item({ priority: 4, dueAt: days(0), pinned: true, attrs: { importance: 5 } });
    assert.equal(score(weighted(), best), 100);
  });

  it('weights scale each factor; custom attributes weigh 0 unless set', () => {
    const base = item({ attrs: { stars: 5, cost: 25 } });
    assert.equal(score(weighted({ priority: 0, dueSoon: 0, importance: 0, pinned: 0 }), base), 0);
    assert.equal(
      score(weighted({ priority: 0, dueSoon: 0, importance: 0, pinned: 0, 'attr.stars': 2 }), base),
      100,
    );
    assert.equal(
      score(weighted({ priority: 0, dueSoon: 0, importance: 0, pinned: 0, 'attr.cost': 1 }), base),
      50,
    );
    const withoutValue = item();
    assert.equal(
      score(
        weighted({ priority: 0, dueSoon: 0, importance: 0, pinned: 0, 'attr.stars': 1 }),
        withoutValue,
      ),
      0,
    );
  });

  it('a weight naming an unknown or non-numeric attribute is skipped, not compiled', () => {
    const { terms, skipped } = weightedTerms(weighted({ 'attr.nope': 5 }), ATTRIBUTES);
    assert.deepEqual(skipped, ['attr.nope']);
    assert.ok(!terms.some((term) => term.factor === 'attr.nope'));
  });

  it('a higher-priority item beats a lower one, all else equal', () => {
    assert.ok(score(weighted(), item({ priority: 4 })) > score(weighted(), item({ priority: 1 })));
  });
});

describe('deadline first (EDF)', () => {
  it('overdue first, then the earliest due, then no due date last', () => {
    const overdue = score(DEADLINE, item({ dueAt: days(-2) }));
    const longOverdue = score(DEADLINE, item({ dueAt: days(-20) }));
    const soon = score(DEADLINE, item({ dueAt: days(1) }));
    const later = score(DEADLINE, item({ dueAt: days(30) }));
    const none = score(DEADLINE, item());
    assert.ok(longOverdue > overdue, 'the longer overdue comes first');
    assert.ok(overdue > soon && soon > later && later > none);
    assert.equal(none, 0);
  });
});

describe('shortest first (SJF)', () => {
  it('smaller sizes score higher; unknown counts as 3 (medium)', () => {
    const small = score(SHORTEST, item({ props: { storyPoints: 1 } }));
    const unknown = score(SHORTEST, item());
    const big = score(SHORTEST, item({ props: { storyPoints: 13 } }));
    assert.ok(small > unknown && unknown > big);
    assert.equal(unknown, 50);
  });

  it('reads the size attribute, story points, then hours / 4', () => {
    assert.equal(sizeOf(item({ attrs: { size: 8 }, props: { storyPoints: 2 } })), 8);
    assert.equal(sizeOf(item({ props: { jira: { storyPoints: 5 } } })), 5);
    assert.equal(sizeOf(item({ props: { linear: { estimate: 2 } } })), 2);
    assert.equal(sizeOf(item({ props: { estimateHours: 8 } })), 2);
    assert.equal(sizeOf(item({ props: { clickup: { timeEstimateMs: 8 * 3_600_000 } } })), 2);
    assert.equal(sizeOf(item()), 3);
    assert.equal(sizeOf(item({ props: { storyPoints: 0 } })), 0.25);
  });
});

describe('fair queue (HRRN)', () => {
  const aged = (waitingDays: number, points: number): ScoredItem =>
    item({ createdAt: days(-waitingDays), props: { storyPoints: points } });

  it('a new task scores 0; waiting raises the score toward 100', () => {
    assert.equal(score(FAIR, aged(0, 3)), 0);
    assert.equal(score(FAIR, aged(3, 3)), 50);
    assert.ok(score(FAIR, aged(300, 3)) >= 99);
    assert.ok(score(FAIR, aged(300, 3)) <= 100);
  });

  it('measures waiting from startAt when there is one, else createdAt', () => {
    const started = item({ createdAt: days(-30), startAt: days(-3), props: { storyPoints: 3 } });
    assert.equal(score(FAIR, started), 50);
    assert.equal(score(FAIR, item({ startAt: days(5) })), 0, 'a future start is not waiting yet');
  });

  it('among equally old tasks the smaller one is first (small tasks win early)', () => {
    assert.ok(score(FAIR, aged(4, 1)) > score(FAIR, aged(4, 13)));
  });

  it('property: a big task that keeps waiting overtakes a newer small one, whatever the sizes', () => {
    for (let big = 2; big <= 40; big += 3) {
      for (let small = 0.5; small < big; small += 1.5) {
        for (let head = 0; head <= 30; head += 6) {
          // The small task has already waited `head` days; the big one starts at the same time.
          // The big one overtakes once its waiting exceeds head * big / small (derived from the
          // ratios), so find that day and check the order flips there and stays flipped.
          const flip = (head * big) / small;
          const ratioAt = (extra: number, points: number, waited: number): number =>
            responseRatio(
              item({ createdAt: days(-(waited + extra)), props: { storyPoints: points } }),
              NOW,
            );
          // Before the flip the small task leads; after it the big task leads.
          assert.ok(
            ratioAt(0, small, head) >= ratioAt(0, big, flip * 0.5),
            [big, small, head].join('/'),
          );
          assert.ok(
            ratioAt(0, big, flip + 1) > ratioAt(0, small, head),
            [big, small, head].join('/'),
          );
          // And with no flip day needed: against a task that has just arrived, any waiting wins.
          assert.ok(ratioAt(0, big, 0.01) > ratioAt(0, small, 0), [big, small].join('/'));
        }
      }
    }
  });

  it('property: the integer score never decreases while a task waits', () => {
    for (const points of [0.5, 1, 3, 8, 21]) {
      let last = -1;
      for (let waited = 0; waited <= 400; waited += 5) {
        const value = score(FAIR, aged(waited, points));
        assert.ok(value >= last && value <= 100);
        last = value;
      }
    }
  });
});

describe('Mongo expression parity', () => {
  let mongo: MemoryMongo;
  let mongoose: typeof MongooseNs.default;

  before(async () => {
    mongo = await startMemoryMongo('todolist_importance_test');
    mongoose = (await import('mongoose')).default;
    await mongoose.connect(mongo.uri);
  });

  after(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  const SAMPLES: ScoredItem[] = [
    item(),
    item({ priority: 4, dueAt: days(0), pinned: true, attrs: { importance: 5 } }),
    item({ priority: 2, dueAt: days(5), attrs: { importance: 2, stars: 4, cost: 10 } }),
    item({ priority: 1, dueAt: days(-3) }),
    item({ dueAt: days(-10.5), attrs: { stars: 1 } }),
    item({ dueAt: days(-100) }),
    item({ dueAt: days(40), pinned: true }),
    item({ createdAt: days(-9), props: { storyPoints: 3 } }),
    item({ createdAt: days(-9), startAt: days(-2), props: { jira: { storyPoints: 13 } } }),
    item({ createdAt: days(-1), props: { linear: { estimate: 1 } } }),
    item({ createdAt: days(-20), props: { estimateHours: 6 } }),
    item({ createdAt: days(-20), props: { clickup: { timeEstimateMs: 4 * 3_600_000 } } }),
    item({ createdAt: days(-20), attrs: { size: 8 } }),
    item({ createdAt: days(-2), props: { storyPoints: 'oops' } }),
    item({ startAt: days(4) }),
  ];

  const CONFIGS: ImportanceConfig[] = [
    weighted(),
    weighted({
      priority: 1,
      dueSoon: 10,
      importance: 0,
      pinned: 5,
      'attr.stars': 3,
      'attr.cost': 2,
    }),
    weighted({ priority: 0, dueSoon: 0, importance: 0, pinned: 0 }),
    DEADLINE,
    SHORTEST,
    FAIR,
  ];

  it('a number attribute with a zero range (stored before it was refused) scores 0 and the query runs', async () => {
    const bad: AttributeDef = { key: 'bad', name: 'Bad', type: 'number', min: 100, builtIn: false };
    const attributes = [...ATTRIBUTES, bad];
    const config = weighted({ 'attr.bad': 5, priority: 1 });
    const sample = item({ priority: 4, attrs: { bad: 50 } });
    assert.ok(Number.isFinite(scoreItem(config, attributes, sample, NOW)));
    const collection = mongoose.connection.collection('parity_zero_range');
    await collection.deleteMany({});
    await collection.insertOne({
      _id: 1 as never,
      priority: 4,
      overlay: { attrs: { bad: 50 } },
      props: {},
    });
    const [row] = await collection
      .aggregate([{ $addFields: importanceFields(config, attributes, NOW) }])
      .toArray();
    assert.ok(Number.isInteger(row?.['importance']));
    assert.equal(row?.['importance'], scoreItem(config, attributes, sample, NOW));
  });

  for (const config of CONFIGS) {
    it(`${config.preset}: the aggregation agrees with the reference scorer`, async () => {
      const collection = mongoose.connection.collection(`parity_${config.preset}`);
      await collection.deleteMany({});
      await collection.insertMany(
        SAMPLES.map((sample, index) => ({
          _id: index as unknown as never,
          priority: sample.priority,
          dueAt: sample.dueAt,
          startAt: sample.startAt,
          createdAt: sample.createdAt,
          overlay: { pinned: sample.pinned ? true : null, attrs: sample.attrs },
          props: sample.props,
        })),
      );
      const rows = await collection
        .aggregate([
          { $addFields: importanceFields(config, ATTRIBUTES, NOW) },
          { $sort: { _id: 1 } },
        ])
        .toArray();
      assert.equal(rows.length, SAMPLES.length);
      rows.forEach((row, index) => {
        const expected = scoreItem(config, ATTRIBUTES, SAMPLES[index] ?? item(), NOW);
        const actual = row['importance'] as number;
        assert.ok(Number.isInteger(actual) && actual >= 0 && actual <= 100, String(actual));
        // $round is half-to-even, Math.round half-up: they may differ by one at a .5 tie.
        assert.ok(
          Math.abs(actual - expected) <= 1,
          `sample ${String(index)}: ${String(actual)} vs ${String(expected)}`,
        );
      });
    });
  }
});
