/**
 * Every code a sync run can report has its own words in both languages (never the generic "The
 * sync hit a problem" line): the server's SyncRun codes (read from SYNC_ERROR_MESSAGES, so a new
 * code without copy fails here) and the calendar push's `calendar_unreachable`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { connect as en } from '../../i18n/translations/en/connect.ts';
import { connect as he } from '../../i18n/translations/he/connect.ts';
import { SYNC_RUN_ERROR_CODES, syncRunErrorKey } from './status.ts';

/** The keys of the server's SYNC_ERROR_MESSAGES (server/src/classes/sync/SyncRun.ts). */
function serverSyncCodes(): string[] {
  const source = readFileSync(
    new URL('../../../../server/src/classes/sync/SyncRun.ts', import.meta.url),
    'utf8',
  );
  const block = /SYNC_ERROR_MESSAGES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/^\s+(\w+):/gm)].map((match) => match[1] ?? '');
}

/** The string at a dotted key under `connect`, or undefined. */
function copyAt(language: unknown, key: string): unknown {
  return key
    .replace(/^connect\./, '')
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      language,
    );
}

describe('sync run errors', () => {
  const codes = [...serverSyncCodes(), 'calendar_unreachable'];

  it('reads the server’s codes (the scan is not vacuous)', () => {
    assert.ok(codes.length >= 20, String(codes.length));
    for (const code of ['auth_failed', 'adapter_error', 'timeout', 'internal']) {
      assert.ok(codes.includes(code), code);
    }
  });

  it('each code has its own copy in English and Hebrew', () => {
    for (const code of codes) {
      const key = syncRunErrorKey(code);
      for (const [name, language] of [
        ['en', en],
        ['he', he],
      ] as const) {
        const copy = copyAt(language, key);
        assert.equal(typeof copy, 'string', `${name} ${key}`);
        assert.notEqual(copy, copyAt(language, 'run.unknownError'), `${name} ${key}`);
      }
    }
  });

  it('a run-only code uses its own copy, any other the connection test’s', () => {
    for (const code of SYNC_RUN_ERROR_CODES) {
      assert.equal(syncRunErrorKey(code), `connect.run.errors.${code}`);
    }
    assert.equal(syncRunErrorKey('auth_failed'), 'connect.testCodes.auth_failed');
    assert.deepEqual(Object.keys(en.run.errors).sort(), [...SYNC_RUN_ERROR_CODES].sort());
    assert.deepEqual(Object.keys(he.run.errors).sort(), [...SYNC_RUN_ERROR_CODES].sort());
  });
});
