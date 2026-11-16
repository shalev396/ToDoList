import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { syncOutcome } from './syncState.ts';

const run = (id: string, status: string) => ({ id, status });

describe('syncOutcome', () => {
  it('is none when no run was queued', () => {
    assert.equal(syncOutcome([], [run('a', 'succeeded')]), 'none');
  });

  it('keeps running while any queued run is queued or running', () => {
    assert.equal(syncOutcome(['a', 'b'], [run('a', 'succeeded'), run('b', 'running')]), 'running');
    assert.equal(syncOutcome(['a'], [run('a', 'queued')]), 'running');
  });

  it('is running until the runs show up in the history', () => {
    assert.equal(syncOutcome(['a'], []), 'running');
  });

  it('only looks at the runs it queued', () => {
    assert.equal(syncOutcome(['a'], [run('old', 'running'), run('a', 'succeeded')]), 'succeeded');
  });

  it('reports the worst finished outcome', () => {
    assert.equal(syncOutcome(['a', 'b'], [run('a', 'succeeded'), run('b', 'partial')]), 'partial');
    assert.equal(syncOutcome(['a', 'b'], [run('a', 'partial'), run('b', 'failed')]), 'failed');
    assert.equal(syncOutcome(['a'], [run('a', 'succeeded')]), 'succeeded');
  });
});
