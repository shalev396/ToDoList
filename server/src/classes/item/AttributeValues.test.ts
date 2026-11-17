/**
 * AttributeValues: an item's custom attribute values, checked against the workspace's definitions
 * when they are set (one AttributeDefinition class per type), immutable, compared by value, shown
 * with dates as ISO strings and text redacted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AppError } from '../../errors/AppError.js';
import type { AttributeDef } from '../../types/attributes.js';
import { AttributeDefinitions } from '../workspace/AttributeDefinitions.js';
import { AttributeValues } from './AttributeValues.js';

const def = (
  key: string,
  type: AttributeDef['type'],
  extra: Partial<AttributeDef> = {},
): AttributeDef => ({
  key,
  name: key,
  type,
  builtIn: false,
  ...extra,
});

const DEFS = AttributeDefinitions.of({
  attributes: [
    def('due', 'date'),
    def('stage', 'select', { options: ['a', 'b'] }),
    def('note', 'text'),
  ],
});

const status400 = (error: unknown): boolean =>
  error instanceof AppError && error.statusCode === 400;

describe('AttributeValues', () => {
  it('checks each value against its definition, storing a date as a Date and null as a clear', () => {
    const values = AttributeValues.checked(
      { importance: 4, due: '2026-12-01', stage: 'b', note: null },
      DEFS,
    );
    const stored = values.toStored();
    assert.equal(stored['importance'], 4);
    assert.ok(stored['due'] instanceof Date);
    assert.equal(stored['stage'], 'b');
    assert.equal(stored['note'], null);
    assert.deepEqual(values.keys, ['importance', 'due', 'stage', 'note']);
  });

  it('refuses an unknown key and a value that does not fit (400 naming the key)', () => {
    assert.throws(
      () => AttributeValues.checked({ nope: 1 }, DEFS),
      (error: unknown) =>
        status400(error) && (error as Error).message.includes('Unknown attribute: nope'),
    );
    assert.throws(() => AttributeValues.checked({ importance: 9 }, DEFS), status400);
    assert.throws(() => AttributeValues.checked({ stage: 'z' }, DEFS), status400);
  });

  it('is immutable: frozen, and hands out copies', () => {
    const source: Record<string, unknown> = { importance: 3 };
    const values = AttributeValues.of(source);
    source['importance'] = 1;
    const stored = values.toStored();
    stored['importance'] = 2;
    assert.equal(values.get('importance'), 3);
    assert.equal(values.get('missing'), undefined);
    assert.ok(Object.isFrozen(values));
  });

  it('compares by value (a date by its instant)', () => {
    const at = (iso: string): Date => new Date(iso);
    assert.ok(
      AttributeValues.of({ due: at('2026-12-01T12:00:00Z'), importance: 2 }).equals(
        AttributeValues.of({ importance: 2, due: at('2026-12-01T12:00:00Z') }),
      ),
    );
    assert.ok(!AttributeValues.of({ importance: 2 }).equals(AttributeValues.of({ importance: 3 })));
    assert.ok(!AttributeValues.of({ importance: 2 }).equals(AttributeValues.of({})));
    assert.ok(
      !AttributeValues.of({ due: at('2026-12-01T12:00:00Z') }).equals(
        AttributeValues.of({ due: '2026-12-01T12:00:00.000Z' }),
      ),
    );
  });

  it('shows no empty value, dates as ISO strings, and text redacted', () => {
    // Built at run time, so no token shape sits in the source.
    const token = ['ghp', 'a'.repeat(36)].join('_');
    const view = AttributeValues.of({
      due: new Date('2026-12-01T12:00:00Z'),
      gone: null,
      note: `token ${token}`,
      importance: 5,
    }).toView();
    assert.deepEqual(Object.keys(view), ['due', 'note', 'importance']);
    assert.equal(view['due'], '2026-12-01T12:00:00.000Z');
    assert.equal(String(view['note']).includes(token), false);
  });
});
