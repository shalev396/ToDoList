/**
 * The daily clean-up: the hourly tick runs the purge in its PURGE_HOUR_UTC tick only, and answers
 * the purge's counts flat (a pass answers numbers).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PURGE_HOUR_UTC } from '../../infra/lib/constants.js';
import { PurgePass } from './PurgePass.js';
import type { PurgeResult } from './purge.js';

function fakePurge(calls: Date[]): (now: Date) => Promise<PurgeResult> {
  return (now) => {
    calls.push(now);
    return Promise.resolve({
      before: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      items: 4,
      containers: 1,
      timedOutRuns: 2,
      orphanedDashboards: { dashboards: 3, versions: 7, views: 5 },
      orphanedTopics: 6,
    });
  };
}

const at = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 10, 24, hour, minute));

describe('PurgePass', () => {
  it('is named purge', () => {
    assert.equal(new PurgePass(fakePurge([])).name, 'purge');
  });

  it('runs the purge in the purge hour, with the tick’s now, and answers its counts flat', async () => {
    const calls: Date[] = [];
    const now = at(PURGE_HOUR_UTC, 1);
    assert.deepEqual(await new PurgePass(fakePurge(calls)).run(now), {
      items: 4,
      containers: 1,
      timedOutRuns: 2,
      orphanedDashboards: 3,
      orphanedVersions: 7,
      orphanedViews: 5,
      orphanedTopics: 6,
    });
    assert.deepEqual(calls, [now]);
  });

  it('runs once a day: in no other hour of the day', async () => {
    const calls: Date[] = [];
    const pass = new PurgePass(fakePurge(calls));
    for (let hour = 0; hour < 24; hour += 1) {
      const counts = await pass.run(at(hour));
      if (hour !== PURGE_HOUR_UTC) assert.deepEqual(counts, {}, `hour ${String(hour)}`);
    }
    assert.deepEqual(calls, [at(PURGE_HOUR_UTC)]);
  });

  it('still runs a tick EventBridge delivered late in the purge hour', async () => {
    const calls: Date[] = [];
    await new PurgePass(fakePurge(calls)).run(at(PURGE_HOUR_UTC, 29));
    assert.equal(calls.length, 1);
  });

  it('lets a failing purge throw (the tick records the pass as failed)', async () => {
    const pass = new PurgePass(() => Promise.reject(new Error('database unreachable')));
    await assert.rejects(pass.run(at(PURGE_HOUR_UTC)), /database unreachable/);
  });
});
