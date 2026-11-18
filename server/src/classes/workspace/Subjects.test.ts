import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AttributeDef } from '../../types/attributes.js';
import type { ColourSubject } from '../../types/colours.js';
import { Subjects } from './Subjects.js';

const def = (over: Partial<AttributeDef> = {}): AttributeDef => ({
  key: 'subject',
  name: 'Subject',
  type: 'select',
  options: ['Calculus', 'Algebra'],
  builtIn: false,
  ...over,
});

describe('Subjects', () => {
  it('completes options without a look with the next free families', () => {
    const subjects = Subjects.of(def()).complete(['blue', 'orange', 'teal']);
    assert.deepEqual(
      subjects.list.map((s) => [s.name, s.family, s.patterns]),
      [
        ['Calculus', 'amber', []],
        ['Algebra', 'pink', []],
      ],
    );
  });

  it('keeps the looks it has when completing', () => {
    const subjects = Subjects.of(
      def({ optionLooks: [{ option: 'Algebra', colour: 'amber', patterns: ['*alg*'] }] }),
    ).complete(['blue']);
    const [calculus, algebra] = subjects.list as [ColourSubject, ColourSubject];
    assert.equal(algebra.family, 'amber');
    assert.deepEqual(algebra.patterns, ['*alg*']);
    assert.equal(calculus.family, 'orange');
  });

  it('updates an existing subject', () => {
    const subjects = Subjects.of(def()).upsert({ name: 'Calculus', patterns: ['*calc*'] }, []);
    assert.deepEqual(subjects.list[0]?.patterns, ['*calc*']);
    assert.equal(subjects.options.length, 2);
  });

  it('renames a subject, keeping its family', () => {
    const before = Subjects.of(def({ options: ['Calc'] })).complete(['blue']);
    const family = before.list[0]?.family;
    const after = before.upsert({ name: 'Calc', rename: 'Calculus' }, ['blue']);
    assert.deepEqual(after.options, ['Calculus']);
    assert.equal(after.list[0]?.family, family);
  });

  it('refuses a rename onto an existing subject or of an unknown one', () => {
    const subjects = Subjects.of(def());
    assert.throws(() => subjects.upsert({ name: 'Calculus', rename: 'Algebra' }, []), /exists/);
    assert.throws(() => subjects.upsert({ name: 'Nope', rename: 'X' }, []), /no such/);
  });

  it('appends a new subject with the next family, or the given one', () => {
    const subjects = Subjects.of(undefined);
    const one = subjects.upsert({ name: 'Physics', patterns: ['*phys*'] }, ['blue']);
    assert.deepEqual(one.list[0], { name: 'Physics', family: 'orange', patterns: ['*phys*'] });
    const two = one.upsert({ name: 'Chem', family: 'green' }, ['blue']);
    assert.equal(two.list[1]?.family, 'green');
  });

  it('throws 400 appending past 30 subjects', () => {
    const options = Array.from({ length: 30 }, (_, i) => `S${String(i)}`);
    assert.throws(
      () => Subjects.of(def({ options })).upsert({ name: 'One more' }, []),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
    );
  });

  it('refuses a bad pattern list', () => {
    assert.throws(
      () => Subjects.of(def()).upsert({ name: 'Calculus', patterns: ['*a'.repeat(13)] }, []),
      /Invalid subject/,
    );
  });

  it('is empty for a definition that is not a select', () => {
    assert.deepEqual(Subjects.of(def({ type: 'text', options: undefined })).options, []);
  });
});
