import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NO_RATE_LIMITS_FLAG, parseLocalArgs } from './localArgs.js';

describe("the local server's command line", () => {
  it('runs against dev with the rate limits on by default', () => {
    assert.deepEqual(parseLocalArgs([]), { stage: 'dev', rateLimits: true });
  });

  it('takes the stage from --stage', () => {
    assert.deepEqual(parseLocalArgs(['--stage', 'qa']), { stage: 'qa', rateLimits: true });
    assert.deepEqual(parseLocalArgs(['--stage', 'prod']), { stage: 'prod', rateLimits: true });
  });

  it('turns the rate limits off only with --no-rate-limits, before or after --stage', () => {
    assert.equal(NO_RATE_LIMITS_FLAG, '--no-rate-limits');
    assert.deepEqual(parseLocalArgs(['--stage', 'qa', '--no-rate-limits']), {
      stage: 'qa',
      rateLimits: false,
    });
    assert.deepEqual(parseLocalArgs(['--no-rate-limits', '--stage', 'dev']), {
      stage: 'dev',
      rateLimits: false,
    });
  });

  it('refuses a stage that does not exist, or a missing one', () => {
    assert.throws(() => parseLocalArgs(['--stage', 'staging']), /Invalid --stage "staging"/);
    assert.throws(() => parseLocalArgs(['--stage']), /Invalid --stage "undefined"/);
  });

  it('refuses any other argument, so a mistyped flag never leaves the limits on quietly', () => {
    for (const args of [
      ['--no-rate-limit'],
      ['--rate-limits=false'],
      ['--stage', 'qa', 'extra'],
      ['--NO-RATE-LIMITS'],
    ]) {
      assert.throws(() => parseLocalArgs(args), /Unknown argument/, args.join(' '));
    }
  });
});
