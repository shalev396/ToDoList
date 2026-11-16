/**
 * PushPlan, the value object: deeply immutable. What was handed in, and anything handed out,
 * can't change it; it is equal by its ops and config.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ORIGIN } from '../../gcal/diff.js';
import { PushPlan, type LoadedPlan } from './PushPlan.js';

function loaded(): LoadedPlan {
  return {
    ops: [
      {
        opId: 'create:item-1:abc',
        type: 'create',
        calendarId: 'cal-1',
        eventId: 'ev1',
        event: {
          id: 'ev1',
          summary: 'Plan it',
          description: '',
          start: { date: '2026-11-20' },
          end: { date: '2026-11-21' },
          status: 'confirmed',
          extendedProperties: {
            private: { origin: ORIGIN, todolistItemId: 'item-1', todolistWs: 'w-1' },
          },
        },
      },
    ],
    entries: [{ type: 'create', itemId: 'item-1', title: 'Plan it' }],
    skipped: [{ itemId: 'item-2', title: 'Capped', reason: 'daily_cap' }],
    counts: { create: 1, update: 0, remove: 0 },
    cfg: {
      workspaceId: 'w-1',
      calendarId: 'cal-1',
      timeZone: 'UTC',
      horizonDays: 90,
      maxOps: 50,
      maxCreates: 0,
      allowDelete: true,
    },
    config: { calendars: [{ id: 'cal-1', mode: 'read' }], horizonDays: 90, maxOpsPerRun: 50 },
  };
}

describe('PushPlan', () => {
  it('reads its plan: ops, calendar, counts, the daily cap, the dry run', () => {
    const plan = PushPlan.of(loaded());
    assert.equal(plan.ops.length, 1);
    assert.equal(plan.calendarId, 'cal-1');
    assert.deepEqual(plan.counts, { create: 1, update: 0, remove: 0 });
    assert.equal(plan.dailyCapReached, true);
    assert.deepEqual(plan.toDryRun().entries, loaded().entries);
  });

  it('is deeply frozen: its ops and their events can’t be changed', () => {
    const plan = PushPlan.of(loaded());
    assert.ok(Object.isFrozen(plan.ops) && Object.isFrozen(plan.ops[0]?.event));
    const [first] = plan.ops;
    assert.ok(first !== undefined);
    assert.throws(() => {
      (plan.ops as WireOpList).push(first);
    }, TypeError);
    assert.throws(() => {
      const event = plan.ops[0]?.event as { summary: string };
      event.summary = 'changed';
    }, TypeError);
    assert.equal(plan.ops[0]?.event?.summary, 'Plan it');
  });

  it('what was handed in and what it hands out are copies: changing them changes nothing', () => {
    const input = loaded();
    const plan = PushPlan.of(input);
    const before = PushPlan.of(loaded());
    input.ops.length = 0;
    input.cfg.calendarId = 'elsewhere';
    const dry = plan.toDryRun();
    dry.entries.push({ type: 'delete', itemId: 'item-9', title: 'Injected' });
    dry.skipped.length = 0;
    const json = plan.toJSON();
    json.ops.length = 0;
    json.cfg.maxCreates = 999;
    assert.equal(plan.ops.length, 1);
    assert.equal(plan.calendarId, 'cal-1');
    assert.equal(plan.toDryRun().entries.length, 1);
    assert.equal(plan.dailyCapReached, true);
    assert.ok(plan.equals(before), 'still equal to the same plan');
  });

  it('is equal by its ops and config, not by identity', () => {
    const other = loaded();
    other.cfg.maxOps = 10;
    assert.ok(PushPlan.of(loaded()).equals(PushPlan.of(loaded())));
    assert.ok(!PushPlan.of(loaded()).equals(PushPlan.of(other)));
  });
});

type WireOpList = LoadedPlan['ops'];
