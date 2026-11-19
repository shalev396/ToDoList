import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { globSource, hasTooManyWildcards, matchesGlob } from './glob.js';

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

describe('glob (linear matcher)', () => {
  it('folds Hebrew quote marks on both sides', () => {
    assert.ok(matchesGlob('*חדו"א*', 'חדו״א 1מ'));
    assert.ok(matchesGlob('*חדו״א*', 'חדו"א 1מ'));
    assert.ok(matchesGlob('ג׳*', "ג' x"));
    assert.ok(new RegExp(globSource('*חדו"א*'), 'isu').test('חדו״א'));
  });
  it('requires parts in order without overlapping the suffix', () => {
    assert.ok(matchesGlob('a*b*c', 'a-b-c'));
    assert.equal(matchesGlob('a*b*c', 'a-c-b'), false);
    assert.equal(matchesGlob('ab*ba', 'aba'), false);
    assert.equal(matchesGlob('*b*b', 'ab'), false);
    assert.ok(matchesGlob('a**b', 'ab'));
  });
  it('agrees with the regular expression on the existing cases', () => {
    const cases: [string, string][] = [
      ['*calc*', 'Intro to CALCULUS'],
      ['braude', 'braude x'],
      ['a.b', 'axb'],
      ['(I)*', '(I) lecture'],
      ['*', 'two\nlines'],
      ['a*b*c', 'xa-b-c'],
      ['*x*y*', 'a\nx\ny'],
      ['', ''],
      ['*', ''],
      ['a/b*', 'A/B/C'],
    ];
    for (const [pattern, text] of cases) {
      assert.equal(
        matchesGlob(pattern, text),
        new RegExp(globSource(pattern), 'isu').test(text),
        `${pattern} vs ${text}`,
      );
    }
  });
  it('counts wildcards', () => {
    assert.equal(hasTooManyWildcards('*a*b*c*d*e*f*g*h'), false);
    assert.ok(hasTooManyWildcards('*'.repeat(9)));
  });
});
