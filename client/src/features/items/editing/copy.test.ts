import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { en } from '../../../i18n/translations/en/index.ts';
import { he } from '../../../i18n/translations/he/index.ts';
import { EDIT_FIELDS } from './editPlan.ts';
import { FREQUENCIES, REPEAT_PRESETS } from '../create/recurrence.ts';

/** Every key path under a block, Hebrew's dual plural (`_two`) left out. */
function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) {
    return [prefix];
  }
  return Object.entries(value)
    .filter(([key]) => !key.endsWith('_two'))
    .flatMap(([key, child]) => keys(child, prefix === '' ? key : `${prefix}.${key}`))
    .sort();
}

describe('the item editing and Repeat texts', () => {
  it('have the same keys in English and Hebrew', () => {
    assert.deepEqual(keys(he.items.edit), keys(en.items.edit));
    assert.deepEqual(keys(he.items.newTodo.repeat), keys(en.items.newTodo.repeat));
  });

  it('name every field, lock, priority, preset and unit the code asks for', () => {
    for (const field of EDIT_FIELDS) {
      assert.equal(typeof en.items.edit.fields[field], 'string', field);
    }
    for (const lock of ['read_only', 'not_owner', 'reconnect', 'writes_off'] as const) {
      assert.match(en.items.edit.lock[lock], /\{\{source\}\}/, lock);
      assert.match(he.items.edit.lock[lock], /\{\{source\}\}/, lock);
    }
    for (const preset of REPEAT_PRESETS) {
      assert.ok(preset in en.items.newTodo.repeat, preset);
    }
    for (const unit of FREQUENCIES) {
      assert.ok(`${unit}_other` in en.items.newTodo.repeat.units, unit);
      assert.ok(`${unit}_two` in he.items.newTodo.repeat.units, unit);
    }
  });

  it('say what Save will do before a save, never that it was done', () => {
    assert.equal(en.items.edit.sentTo, 'Saving also changes it in {{source}}.');
    assert.doesNotMatch(en.items.edit.sentTo, /saved/i);
    assert.doesNotMatch(he.items.edit.sentTo, /^נשמר/);
    // The past tense is kept for after a write that was taken, naming what was sent.
    assert.match(en.items.edit.sentFields, /{{fields}}/);
  });

  it('never call a provider refusal "changed in the meantime"', () => {
    for (const text of [en.items.edit.errors.refused, en.items.edit.errors.rejected]) {
      assert.doesNotMatch(text, /meantime/);
    }
    assert.match(en.items.edit.uncertain.title, /may have been made/);
  });

  it('use the brief’s words for the locks', () => {
    assert.equal(
      en.items.edit.lock.read_only,
      'Read-only. Switch {{source}} to Read & write to edit it there.',
    );
    assert.equal(en.items.edit.lock.not_owner, 'Only {{owner}} can change this at {{source}}.');
    assert.equal(en.items.edit.lock.reconnect, 'Reconnect {{source}} to allow edits.');
    assert.equal(
      en.items.newTodo.repeat.calendarOnly,
      'Repeating to-dos are created in Google Calendar only',
    );
  });
});
