import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AttributePatchSchema, NewAttributeSchema } from './attributes.js';

const select = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: 'subject',
  name: 'Subject',
  type: 'select',
  options: ['Calculus', 'Algebra'],
  optionLooks: [{ option: 'Calculus', colour: 'blue', patterns: ['*calc*'] }],
  ...over,
});

describe('option looks', () => {
  it('parses a select with looks', () => {
    assert.ok(NewAttributeSchema.safeParse(select()).success);
  });
  it('rejects a look naming no option', () => {
    const looks = [{ option: 'Physics', colour: 'blue', patterns: [] }];
    assert.equal(NewAttributeSchema.safeParse(select({ optionLooks: looks })).success, false);
  });
  it('rejects looks on a text attribute', () => {
    assert.equal(
      NewAttributeSchema.safeParse(select({ type: 'text', options: undefined })).success,
      false,
    );
  });
  it('rejects two looks for one option', () => {
    const look = { option: 'Calculus', colour: 'blue', patterns: [] };
    assert.equal(
      NewAttributeSchema.safeParse(select({ optionLooks: [look, look] })).success,
      false,
    );
  });
  it('rejects a pattern of 101 characters', () => {
    const looks = [{ option: 'Calculus', colour: 'blue', patterns: ['a'.repeat(101)] }];
    assert.equal(NewAttributeSchema.safeParse(select({ optionLooks: looks })).success, false);
  });
  it('parses renames on a patch', () => {
    const parsed = AttributePatchSchema.safeParse({ renames: [{ from: 'A', to: 'B' }] });
    assert.ok(parsed.success);
  });
});
