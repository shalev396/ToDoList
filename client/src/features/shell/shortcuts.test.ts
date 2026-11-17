import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHORD_WINDOW_MS,
  createShortcutMachine,
  keyOf,
  type ShortcutKeyInput,
} from './shortcuts.ts';

function press(key: string, code: string, extra: Partial<ShortcutKeyInput> = {}): ShortcutKeyInput {
  return {
    key,
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    typing: false,
    ...extra,
  };
}

describe('shortcut machine', () => {
  it('goes to a page on "g" then a letter', () => {
    const machine = createShortcutMachine(() => 0);
    assert.equal(machine(press('g', 'KeyG')), null);
    assert.deepEqual(machine(press('d', 'KeyD')), { type: 'go', key: 'd' });
  });

  it('works on a Hebrew layout, where event.key is not a Latin letter', () => {
    const machine = createShortcutMachine(() => 0);
    assert.equal(keyOf(press('ע', 'KeyG')), 'g');
    assert.equal(machine(press('ע', 'KeyG')), null);
    assert.deepEqual(machine(press('ג', 'KeyD')), { type: 'go', key: 'd' });
  });

  it('forgets a lone "g" after the chord window', () => {
    let time = 0;
    const machine = createShortcutMachine(() => time);
    machine(press('g', 'KeyG'));
    time = CHORD_WINDOW_MS;
    assert.equal(machine(press('d', 'KeyD')), null);
  });

  it('does not chain: the key after a chord starts fresh', () => {
    const machine = createShortcutMachine(() => 0);
    machine(press('g', 'KeyG'));
    machine(press('d', 'KeyD'));
    assert.equal(machine(press('c', 'KeyC')), null);
  });

  it('ignores keys typed in a field, with a modifier, or already handled', () => {
    const machine = createShortcutMachine(() => 0);
    machine(press('g', 'KeyG', { typing: true }));
    assert.equal(machine(press('d', 'KeyD', { typing: true })), null);
    machine(press('g', 'KeyG'));
    assert.equal(machine(press('d', 'KeyD', { altKey: true })), null);
    machine(press('g', 'KeyG'));
    assert.equal(machine(press('d', 'KeyD', { defaultPrevented: true })), null);
  });

  it('opens the palette on Ctrl/Cmd+K even from a field', () => {
    const machine = createShortcutMachine(() => 0);
    assert.deepEqual(machine(press('k', 'KeyK', { ctrlKey: true, typing: true })), {
      type: 'palette',
    });
    assert.deepEqual(machine(press('k', 'KeyK', { metaKey: true })), { type: 'palette' });
  });

  it('toggles the sidebar on "[" and opens the help on "?"', () => {
    const machine = createShortcutMachine(() => 0);
    assert.deepEqual(machine(press('[', 'BracketLeft')), { type: 'sidebar' });
    assert.deepEqual(machine(press('?', 'Slash', { shiftKey: true })), { type: 'help' });
    assert.deepEqual(machine(press('/', 'Slash', { shiftKey: true })), { type: 'help' });
  });
});
