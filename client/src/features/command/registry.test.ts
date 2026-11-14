import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  filterCommands,
  groupCommands,
  mergeCommandSources,
  normalizeForSearch,
  type AppCommand,
} from './registry.ts';

const noop = () => undefined;

function command(
  id: string,
  group: AppCommand['group'],
  label: string,
  keywords: string[] = [],
): AppCommand {
  return { id, group, label, keywords, run: noop };
}

const commands: AppCommand[] = [
  command('go-dashboard', 'navigation', 'Dashboard', ['home', 'today']),
  command('go-work', 'navigation', 'Work'),
  command('go-settings', 'navigation', 'Settings', ['workspace', 'time zone']),
  command('workspace-ada', 'workspaces', 'Switch to Ada Lab', ['workspace']),
  command('workspace-cafe', 'workspaces', 'Switch to Café Société', ['workspace']),
  command('theme-dark', 'preferences', 'Use dark theme', ['appearance', 'mode']),
  command('sign-out', 'account', 'Sign out', ['log out', 'logout']),
  command('go-he-settings', 'navigation', 'הגדרות', ['settings']),
];

const ids = (list: readonly AppCommand[]) => list.map((c) => c.id);

describe('normalizeForSearch', () => {
  it('ignores case, accents, Hebrew points and extra spaces', () => {
    assert.equal(normalizeForSearch('  Café   SOCIÉTÉ '), 'cafe societe');
    assert.equal(normalizeForSearch('שָׁלוֹם'), 'שלום');
  });
});

describe('filterCommands', () => {
  it('returns everything, in group order, for an empty query', () => {
    assert.deepEqual(ids(filterCommands(commands, '   ')), [
      'go-dashboard',
      'go-work',
      'go-settings',
      'go-he-settings',
      'workspace-ada',
      'workspace-cafe',
      'theme-dark',
      'sign-out',
    ]);
  });

  it('matches the start of a label', () => {
    assert.deepEqual(ids(filterCommands(commands, 'dash')), ['go-dashboard']);
  });

  it('matches keywords too, but ranks label matches first within a group', () => {
    assert.deepEqual(ids(filterCommands(commands, 'settings')), ['go-settings', 'go-he-settings']);
    assert.deepEqual(ids(filterCommands(commands, 'logout')), ['sign-out']);
  });

  it('needs every word of the query, in any field', () => {
    assert.deepEqual(ids(filterCommands(commands, 'switch ada')), ['workspace-ada']);
    assert.deepEqual(ids(filterCommands(commands, 'workspace ada')), ['workspace-ada']);
    assert.deepEqual(ids(filterCommands(commands, 'switch zzz')), []);
  });

  it('ignores accents in the query and in labels', () => {
    assert.deepEqual(ids(filterCommands(commands, 'cafe')), ['workspace-cafe']);
    assert.deepEqual(ids(filterCommands(commands, 'SOCIÉTÉ')), ['workspace-cafe']);
  });

  it('finds Hebrew labels', () => {
    assert.deepEqual(ids(filterCommands(commands, 'הגד')), ['go-he-settings']);
  });

  it('keeps groups in their order however well each one matches', () => {
    const list = [
      command('a', 'account', 'Theme notes'),
      command('b', 'navigation', 'My theme'),
      command('c', 'preferences', 'Theme'),
    ];
    assert.deepEqual(ids(filterCommands(list, 'theme')), ['b', 'c', 'a']);
  });

  it('leaves out hidden commands', () => {
    const list = [
      command('a', 'navigation', 'Members'),
      { ...command('b', 'navigation', 'Members too'), hidden: true },
    ];
    assert.deepEqual(ids(filterCommands(list, 'members')), ['a']);
  });
});

describe('groupCommands', () => {
  it('groups in display order and drops empty groups', () => {
    const grouped = groupCommands(filterCommands(commands, 'workspace'));
    assert.deepEqual(
      grouped.map((g) => [g.group, ids(g.commands)]),
      [
        ['navigation', ['go-settings']],
        ['workspaces', ['workspace-ada', 'workspace-cafe']],
      ],
    );
  });
});

describe('mergeCommandSources', () => {
  it('flattens every source, the later one winning on a repeated id', () => {
    const merged = mergeCommandSources([
      [command('go-work', 'navigation', 'Work'), command('sign-out', 'account', 'Sign out')],
      [
        command('go-work', 'navigation', 'Work (new)'),
        command('add-block', 'actions', 'Add block'),
      ],
    ]);
    assert.deepEqual(
      merged.map((c) => [c.id, c.label]),
      [
        ['go-work', 'Work (new)'],
        ['sign-out', 'Sign out'],
        ['add-block', 'Add block'],
      ],
    );
  });
});
