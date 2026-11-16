import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findSecrets, redactString, scanTextForSecrets } from './secretPatterns.js';

// A Moodle web-service token is 32 hex characters, so it cannot carry FAKE: it is built at run
// time, and this file's text never holds one for the repo scanner to find.
const MOODLE_TOKEN = '0a1b2c3d'.repeat(4);
const APPS_SCRIPT_ID = 'AKfycbFAKE0123456789abcdefghijklmnop';

// Fake values shaped like real ones. Every literal carries FAKE so the repo scanner ignores them.
const CORPUS: Record<string, string> = {
  clickup: 'pk_12345678_FAKEABCDEFGHIJKLMNOPQRSTUV',
  linear: 'lin_api_FAKEabcdefghijklmnopqrstuvwx',
  jira: 'ATATT3xFfGF0FAKEabcdefghijklmnopqrstuvwx',
  // Joined at runtime: GitHub push protection blocks a literal Slack-shaped token, FAKE or not.
  slack: ['xoxb', '1234567890', 'FAKE', 'abcdefghij'].join('-'),
  slackRotating: ['xoxe', '1', 'FAKEabcdefghijklmnop'].join('-'),
  slackRotatingDot: ['xoxe', 'FAKE1-abcdefghijklmnop'].join('.'),
  githubClassic: 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123',
  githubFineGrained: 'github_pat_11FAKE_abcdefghijklmnopqrstuvwxyz',
  agentKey: 'elk_FAKEabcdefghijklmnopqrst',
  mongoUri: 'mongodb+srv://dev-user:FAKE-pa55word@cluster0.example.mongodb.net/todolist_dev',
  pem: '-----BEGIN FAKE PRIVATE KEY-----',
  // Split so this file does not itself look like a key block to the repo scanner.
  pgp: '-----BEGIN ' + 'PGP PRIVATE KEY BLOCK-----',
  bearer: 'Bearer FAKEabcdefghijklmnopqrstuvwx',
  moodleUrl: `https://moodle.example.invalid/webservice/rest/server.php?wstoken=${MOODLE_TOKEN}&wsfunction=core_webservice_get_site_info`,
  appsScriptUrl: `https://script.google.com/macros/s/${APPS_SCRIPT_ID}/exec`,
  googleAccessToken: 'ya29.a0AfB_FAKEbyC1234567890abcdefghij-KLMN',
};
const JWT_FAKE = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.FAKEsignatureFAKEsignature`;

describe('findSecrets', () => {
  it('finds every provider token shape, reporting paths and kinds but never values', () => {
    for (const [name, value] of Object.entries(CORPUS)) {
      const hits = findSecrets({ nested: { list: ['ok', `note: ${value}`] } });
      assert.equal(hits.length, 1, `${name} not detected`);
      assert.equal(hits[0]?.path, '$.nested.list[1]');
      assert.equal(JSON.stringify(hits).includes(value), false, `${name} value leaked in report`);
    }
  });

  it('flags deny-listed keys whatever their value', () => {
    const hits = findSecrets({
      integration: { enc: { ciphertext: 'abc' }, apiKey: 'x', name: 'ok' },
    });
    assert.deepEqual(hits.map((hit) => hit.path).sort(), [
      '$.integration.apiKey',
      '$.integration.enc',
    ]);
  });

  it('flags JWTs unless the caller allows session tokens', () => {
    assert.equal(findSecrets({ idToken: JWT_FAKE }).length, 1);
    assert.equal(findSecrets({ idToken: JWT_FAKE }, { allow: ['jwt'] }).length, 0);
  });

  it('allows an agent key only when explicitly permitted', () => {
    assert.equal(findSecrets({ key: CORPUS['agentKey'] }).length, 1);
    assert.equal(findSecrets({ key: CORPUS['agentKey'] }, { allow: ['agent_key'] }).length, 0);
  });

  it('passes ordinary data', () => {
    assert.deepEqual(
      findSecrets({
        title: 'Fix the sync token refresh bug',
        tokens: 3,
        url: 'https://github.com/a/b/pull/1',
      }),
      [],
    );
  });
});

describe('redactString', () => {
  it('replaces each secret with a kind marker', () => {
    const text = `token ${CORPUS['githubClassic'] ?? ''} and ${CORPUS['mongoUri'] ?? ''}`;
    const out = redactString(text);
    assert.equal(out.includes('ghp_FAKE'), false);
    assert.equal(out.includes('FAKE-pa55word'), false);
    assert.match(out, /\[REDACTED:github_token\]/);
    assert.match(out, /\[REDACTED:database_credentials\]/);
  });
});

describe('scanTextForSecrets (repo scanner)', () => {
  it('reports line numbers and kinds for real-looking tokens', () => {
    const findings = scanTextForSecrets(`line one\nconst t = 'ghp_${'R'.repeat(36)}';\n`);
    assert.deepEqual(findings, [{ line: 2, kind: 'github_token' }]);
  });

  it('scans JWTs too, but not bearer strings', () => {
    const jwt = `eyJ${'h'.repeat(10)}.eyJ${'p'.repeat(10)}.${'s'.repeat(12)}`;
    assert.deepEqual(scanTextForSecrets(`token = '${jwt}'`), [{ line: 1, kind: 'jwt' }]);
    assert.deepEqual(scanTextForSecrets(`Authorization: Bearer ${'b'.repeat(24)}`), []);
    assert.deepEqual(scanTextForSecrets(`const t = '${JWT_FAKE}';`), []);
  });

  it('ignores FAKE fixtures and <placeholder> credentials', () => {
    const text = [
      `const t = '${CORPUS['githubClassic'] ?? ''}';`,
      'DATABASE_URL="mongodb+srv://<user>:<password>@<cluster>.mongodb.net/db"',
    ].join('\n');
    assert.deepEqual(scanTextForSecrets(text), []);
  });
});

describe('provider URL tokens (Moodle wstoken, Apps Script /exec)', () => {
  it('redacts the token part and keeps the rest of the URL', () => {
    const moodle = redactString(CORPUS['moodleUrl'] ?? '');
    assert.equal(moodle.includes(MOODLE_TOKEN), false);
    assert.match(
      moodle,
      /server\.php\?\[REDACTED:provider_url_token\]&wsfunction=core_webservice_get_site_info$/,
    );
    const script = redactString(`execUrl: ${CORPUS['appsScriptUrl'] ?? ''}`);
    assert.equal(script.includes(APPS_SCRIPT_ID), false);
    assert.equal(script, 'execUrl: https://script.google.com[REDACTED:provider_url_token]');
    // A Google Workspace deployment: /a/macros/<domain>/s/<id>/exec.
    const workspace = `https://script.google.com/a/macros/example.invalid/s/${APPS_SCRIPT_ID}/exec`;
    assert.deepEqual(findSecrets({ workspace }), [
      { path: '$.workspace', kind: 'provider_url_token' },
    ]);
  });

  it('leaves look-alikes alone', () => {
    for (const text of [
      'wstoken=FAKE123',
      `wstoken=${'0a'.repeat(15)}`,
      `wstoken=${MOODLE_TOKEN}ab`,
      'https://script.google.com/home/projects/FAKE/edit',
      'https://script.google.com/macros/s/FAKE-short/exec',
    ]) {
      assert.deepEqual(findSecrets({ text }), [], text);
    }
  });

  it('the repo scanner reports real-looking URL tokens and ignores FAKE fixtures', () => {
    const realScript = `const url = 'https://script.google.com/macros/s/AKfycb${'R'.repeat(40)}/exec';`;
    assert.deepEqual(scanTextForSecrets(realScript), [{ line: 1, kind: 'provider_url_token' }]);
    assert.deepEqual(scanTextForSecrets(`url = '?wstoken=${MOODLE_TOKEN}'`), [
      { line: 1, kind: 'provider_url_token' },
    ]);
    assert.deepEqual(scanTextForSecrets(`execUrl: '${CORPUS['appsScriptUrl'] ?? ''}'`), []);
  });
});

describe('Google OAuth access tokens (ya29.)', () => {
  const TOKEN = CORPUS['googleAccessToken'] ?? '';
  // Real-looking (no FAKE): built at run time, so this file's text never holds one.
  const REAL_LOOKING = `ya29.${'a0AfB_c1-'.repeat(6)}`;

  it('is its own kind, wherever the token sits', () => {
    for (const text of [
      TOKEN,
      `{"access_token":"${TOKEN}","token_type":"Bearer"}`,
      `https://www.googleapis.com/drive/v3/about?access_token=${TOKEN}&fields=user`,
      `token=${TOKEN}`,
    ]) {
      assert.deepEqual(
        findSecrets({ text }),
        [{ path: '$.text', kind: 'google_access_token' }],
        text,
      );
    }
  });

  it('redacts the token and keeps the rest of the text', () => {
    assert.equal(
      redactString(`https://www.googleapis.com/drive/v3/about?access_token=${TOKEN}&fields=user`),
      'https://www.googleapis.com/drive/v3/about?access_token=[REDACTED:google_access_token]&fields=user',
    );
    assert.equal(
      redactString(`{"access_token":"${TOKEN}"}`),
      '{"access_token":"[REDACTED:google_access_token]"}',
    );
  });

  it('leaves look-alikes alone: too short, another prefix, no dot', () => {
    for (const text of [
      'ya29.FAKE-short',
      `ya29.${'FAKE'.repeat(4)}`,
      `ya28.${'FAKE'.repeat(6)}`,
      `ya29-${'FAKE'.repeat(6)}`,
      `ya29${'FAKE'.repeat(6)}`,
      `ya29. ${'FAKE'.repeat(6)}`,
    ]) {
      assert.deepEqual(findSecrets({ text }), [], text);
    }
  });

  it('the repo scanner reports a real-looking one and ignores FAKE fixtures', () => {
    assert.deepEqual(scanTextForSecrets(`const token = '${REAL_LOOKING}';`), [
      { line: 1, kind: 'google_access_token' },
    ]);
    assert.deepEqual(scanTextForSecrets(`const token = '${TOKEN}';`), []);
    assert.deepEqual(scanTextForSecrets(`"access_token": "ya29.FAKE-drive-access-token"`), []);
  });
});
