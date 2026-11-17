/**
 * Items are made by `Item.from`, which needs every item class registered: loading the item reads
 * (ItemQuery), the classes' barrel, or what serves items (the controller, the query service) must
 * register all four by itself, whatever else the process loads. Each entry runs in a fresh process.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const ENTRIES = [
  'src/classes/item/index.ts',
  'src/classes/item/ItemQuery.ts',
  'src/classes/index.ts',
  'src/controllers/items.ts',
  'src/services/workspaceQuery.ts',
];

/** The class each kind of stored item is made as, after importing `entry` alone. */
function classesAfterImporting(entry: string): string[] {
  const script = `await import(${JSON.stringify(`./${entry}`)});
    const { Item } = await import('./src/classes/item/Item.ts');
    const made = [
      ['local', 'todo'],
      ['github', 'issue'],
      ['github', 'pr'],
      ['google_calendar', 'event'],
    ].map(([provider, kind]) => Item.fromDoc({ _id: 'x', kind, source: { provider } }).constructor.name);
    console.log(JSON.stringify(made));`;
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } },
  );
  return JSON.parse(out.trim().split('\n').pop() ?? '[]') as string[];
}

describe('the item classes are registered by what reads items, alone', () => {
  for (const entry of ENTRIES) {
    it(`${entry}: a to-do, a task, a pull request and an event`, () => {
      assert.deepEqual(classesAfterImporting(entry), [
        'Todo',
        'TaskItem',
        'PullRequest',
        'CalendarEvent',
      ]);
    });
  }
});
