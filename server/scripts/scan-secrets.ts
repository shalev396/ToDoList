/**
 * npm run secrets:scan (repo root): scans tracked files for secret-shaped values.
 * With --staged it scans the staged content of staged files (the pre-commit hook).
 * Prints `path:line kind`, never the value. Exits 1 when anything is found.
 * Test fixtures mark fake tokens with FAKE; docs use <placeholders>. Both are ignored.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { scanTextForSecrets } from '../src/services/secretPatterns.js';
import { SERVER_ROOT } from './paths.js';

const REPO_ROOT = join(SERVER_ROOT, '..');
const SKIP = /(^|\/)package-lock\.json$|\.(png|jpe?g|gif|webp|ico|glb|zip|pdf|woff2?|ttf|otf)$/i;
const staged = process.argv.includes('--staged');

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

const files = (
  staged ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']) : git(['ls-files'])
)
  .split('\n')
  .filter((file) => file !== '' && !SKIP.test(file));

let findings = 0;
for (const file of files) {
  let text: string;
  try {
    text = staged ? git(['show', `:${file}`]) : readFileSync(join(REPO_ROOT, file), 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0') || text.length > 2_000_000) continue;
  for (const { line, kind } of scanTextForSecrets(text)) {
    console.error(`${file}:${String(line)}  ${kind}`);
    findings += 1;
  }
}

if (findings > 0) {
  console.error(
    `\n${String(findings)} possible secret(s). Remove them, or mark test fixtures with FAKE, then commit again.`,
  );
  process.exitCode = 1;
} else {
  console.warn(`secrets:scan: ${String(files.length)} file(s) clean`);
}
