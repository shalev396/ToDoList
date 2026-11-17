import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buttonVariants } from './button-variants.ts';

describe('button motion', () => {
  it('runs no transition under reduced motion', () => {
    // A button that was disabled (opacity 50%) fades back in when it is enabled: with reduced
    // motion it must be at full contrast at once (CI's axe check caught it mid-fade at 3.42:1).
    const classes = buttonVariants().split(/\s+/);
    assert.ok(classes.includes('transition-all'));
    assert.ok(classes.includes('motion-reduce:transition-none'));
  });
});
