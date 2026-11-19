import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_ROUNDS,
  runRounds,
  type RoundInvoker,
  type RoundResponse,
} from '../../scripts/sync-db-rounds.js';

/**
 * The deploy script's round loop (scripts/sync-db-rounds.ts) with a fake invoker: nothing here
 * reaches AWS.
 */
function answer(done: boolean, pending: string[] = []): RoundResponse {
  const body = JSON.stringify({ provider: 'mongoose', results: [], done, pending });
  return { functionError: undefined, payload: JSON.stringify({ statusCode: 200, body }) };
}

const TIMEOUT: RoundResponse = {
  functionError: 'Unhandled',
  payload: '{"errorMessage":"2026-11-19T10:00:00.000Z abc Task timed out after 300.00 seconds"}',
};

/** An invoker answering from `responses` in order (the last one repeats); counts its calls. */
function fake(responses: RoundResponse[]): { invoke: RoundInvoker; calls: () => number } {
  let calls = 0;
  const invoke: RoundInvoker = () => {
    const response = responses[Math.min(calls, responses.length - 1)];
    calls++;
    if (response === undefined) throw new Error('no response');
    return Promise.resolve(response);
  };
  return { invoke, calls: () => calls };
}

describe('sync-db rounds', () => {
  it('stops after the first round when it is done', async () => {
    const { invoke, calls } = fake([answer(true)]);
    const lines: string[] = [];
    const body = await runRounds(invoke, (line) => lines.push(line));
    assert.equal(calls(), 1);
    assert.equal((JSON.parse(body) as { done: boolean }).done, true);
    assert.equal(lines.length, 1);
  });

  it('loops while it answers done:false, as long as the pending list shrinks', async () => {
    const { invoke, calls } = fake([
      answer(false, ['a', 'b', 'c']),
      answer(false, ['c']),
      answer(true),
    ]);
    const lines: string[] = [];
    await runRounds(invoke, (line) => lines.push(line));
    assert.equal(calls(), 3);
    assert.match(lines.join('\n'), /3 pending \(a, b, c\)/);
  });

  it('retries a timed-out round', async () => {
    const { invoke, calls } = fake([TIMEOUT, answer(false, ['a']), TIMEOUT, answer(true)]);
    await runRounds(invoke, () => undefined);
    assert.equal(calls(), 4);
  });

  it('fails after two timeouts in a row', async () => {
    const { invoke, calls } = fake([TIMEOUT]);
    await assert.rejects(
      runRounds(invoke, () => undefined),
      /timed out 2 rounds in a row/,
    );
    assert.equal(calls(), 2);
  });

  it('fails after two rounds in a row with the same pending list', async () => {
    const { invoke, calls } = fake([
      answer(false, ['a']),
      answer(false, ['a']),
      answer(false, ['a']),
    ]);
    await assert.rejects(
      runRounds(invoke, () => undefined),
      /no progress/,
    );
    assert.equal(calls(), 3);
  });

  it('gives up after 10 rounds', async () => {
    let round = 0;
    const invoke: RoundInvoker = () => Promise.resolve(answer(false, [`m${String(round++)}`]));
    await assert.rejects(
      runRounds(invoke, () => undefined),
      /not done after 10 rounds/,
    );
    assert.equal(round, MAX_ROUNDS);
  });

  it('fails at once on a refused or failed round that is not a timeout', async () => {
    const refused = { functionError: undefined, payload: '{"statusCode":500,"body":"{}"}' };
    const { invoke, calls } = fake([refused]);
    await assert.rejects(
      runRounds(invoke, () => undefined),
      /sync-db failed/,
    );
    assert.equal(calls(), 1);
    const crashed = fake([{ functionError: 'Unhandled', payload: '{"errorMessage":"boom"}' }]);
    await assert.rejects(
      runRounds(crashed.invoke, () => undefined),
      /sync-db failed/,
    );
  });
});
