import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRetryableStart } from './memoryMongo.js';

describe('isRetryableStart', () => {
  it('retries a port another test file took, or a temp directory lost while starting', () => {
    assert.equal(isRetryableStart(new Error('Port "35153" already in use')), true);
    assert.equal(isRetryableStart(new Error('Instance closed unexpectedly with code "48"')), true);
    assert.equal(isRetryableStart(new Error('Instance exited with code: 48')), true);
    assert.equal(isRetryableStart(new Error('NonExistentPath: Data directory not found')), true);
  });

  it('never retries anything else', () => {
    assert.equal(isRetryableStart(new Error('Instance exited with code 1')), false);
    assert.equal(isRetryableStart(new Error('code 480 is not a mongod exit')), false);
    assert.equal(isRetryableStart(new Error('launch timed out')), false);
    assert.equal(isRetryableStart('already in use'), false);
  });
});
