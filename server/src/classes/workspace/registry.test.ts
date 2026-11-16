/**
 * The workspace classes disconnect integrations (a member leaves, a workspace is deleted), so
 * loading them, or a controller that uses them, must register every provider class by itself,
 * whatever else the process loads. Each entry runs in a fresh process.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const ENTRIES = [
  'src/classes/workspace/index.ts',
  'src/classes/workspace/Workspace.ts',
  'src/classes/User.ts',
  'src/controllers/workspaces.ts',
];

function registeredAfterImporting(entry: string): string[] {
  const script = `await import(${JSON.stringify(`./${entry}`)});
    const { IntegrationRegistry } = await import('./src/classes/integration/IntegrationRegistry.ts');
    console.log(JSON.stringify(IntegrationRegistry.instance.providers()));`;
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } },
  );
  return JSON.parse(out.trim().split('\n').pop() ?? '[]') as string[];
}

describe('provider classes are registered by the workspace classes alone', () => {
  for (const entry of ENTRIES) {
    it(`${entry} registers all six providers`, () => {
      assert.deepEqual(registeredAfterImporting(entry), [
        'clickup',
        'github',
        'google_calendar',
        'jira',
        'linear',
        'moodle',
      ]);
    });
  }
});
