import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { globSource, matchesGlob } from './glob.js';

describe('glob', () => {
  it('builds an anchored source with * as .*', () => {
    assert.equal(globSource('a*b'), '^a.*b$');
  });
  it('matches the whole text, ignoring case', () => {
    assert.ok(matchesGlob('*calc*', 'Intro to CALCULUS'));
    assert.equal(matchesGlob('braude', 'braude x'), false);
  });
  it('treats everything but * literally', () => {
    assert.equal(matchesGlob('a.b', 'axb'), false);
    assert.ok(matchesGlob('(I)*', '(I) lecture'));
  });
  it('lets * span line breaks', () => {
    assert.ok(matchesGlob('*', 'two\nlines'));
  });
});
