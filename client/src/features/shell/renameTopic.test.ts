import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renameStep } from './renameTopic.ts';

describe('renameStep', () => {
  it('saves a changed name, trimmed or not', () => {
    assert.equal(renameStep('Freelance', 'Side gig', false), 'save');
    assert.equal(renameStep('  Freelance ', 'Side gig', false), 'save');
  });

  it('closes on an empty or unchanged name', () => {
    assert.equal(renameStep('   ', 'Side gig', false), 'close');
    assert.equal(renameStep(' Side gig ', 'Side gig', false), 'close');
  });

  it('waits while a save is in flight: the blur of the disabled field closes nothing', () => {
    assert.equal(renameStep('Freelance', 'Side gig', true), 'wait');
    assert.equal(renameStep('Side gig', 'Side gig', true), 'wait');
  });
});
