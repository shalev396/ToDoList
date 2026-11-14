/**
 * The MCP secret guard (MCP.md §5.4, §12): every token format is blocked wherever it sits in a
 * JSON-RPC message; reports name paths and kinds, never values; dev and qa throw while prod does
 * not.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as GuardHarness from '../../testing/guardHarness.js';
import type * as Redact from '../middleware/redact.js';

let redact: typeof Redact;
let captureStderr: typeof GuardHarness.captureStderr;

before(async () => {
  redact = await import('../middleware/redact.js');
  ({ captureStderr } = await import('../../testing/guardHarness.js'));
});

// Fake values shaped like real ones. Every literal carries FAKE so the repo scanner ignores them.
const CORPUS: Record<string, string> = {
  clickup: 'pk_12345678_FAKEABCDEFGHIJKLMNOPQRSTUV',
  linear: 'lin_api_FAKEabcdefghijklmnopqrstuvwx',
  jira: 'ATATT3xFfGF0FAKEabcdefghijklmnopqrstuvwx',
  // Joined at runtime: GitHub push protection blocks a literal Slack-shaped token, FAKE or not.
  slack: ['xoxb', '1234567890', 'FAKE', 'abcdefghij'].join('-'),
  githubClassic: 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123',
  githubFineGrained: 'github_pat_11FAKE_abcdefghijklmnopqrstuvwxyz',
  agentKey: 'elk_FAKEabcdefghijklmnopqrst',
  mongoUri: 'mongodb+srv://dev-user:FAKE-pa55word@cluster0.example.mongodb.net/todolist_dev',
  pem: '-----BEGIN FAKE PRIVATE KEY-----',
  bearer: 'Bearer FAKEabcdefghijklmnopqrstuvwx',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.FAKEsignatureFAKEsignature',
};

function toolResponse(text: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 4,
    result: {
      content: [{ type: 'text', text }],
      structuredContent: { members: [{ name: text }] },
    },
  };
}

function quietly(fn: () => void): Promise<string> {
  return captureStderr(() => {
    fn();
    return Promise.resolve();
  });
}

describe('blockSecrets', () => {
  it('throws on dev and qa for every token format, naming paths and kinds only', async () => {
    const logs = await quietly(() => {
      for (const env of ['dev', 'qa'] as const) {
        for (const [name, value] of Object.entries(CORPUS)) {
          assert.throws(
            () => redact.blockSecrets(toolResponse(`pasted ${value}`), 'a test response', env),
            (error: unknown) =>
              error instanceof Error &&
              error.name === 'SecretLeakError' &&
              error.message.includes('$.result.structuredContent.members[0].name') &&
              !error.message.includes(value),
            `${env} ${name}`,
          );
        }
      }
    });
    for (const value of Object.values(CORPUS)) assert.equal(logs.includes(value), false);
  });

  it('blocks without throwing on prod', async () => {
    await quietly(() => {
      for (const [name, value] of Object.entries(CORPUS)) {
        assert.equal(
          redact.blockSecrets(toolResponse(value), 'a test response', 'prod'),
          true,
          name,
        );
      }
    });
  });

  it('blocks a deny-listed key anywhere in a message', async () => {
    await quietly(() => {
      assert.equal(
        redact.blockSecrets({ result: { structuredContent: { secret: 'x' } } }, 'a test', 'prod'),
        true,
      );
    });
  });

  it('passes ordinary data, including words like token in prose', () => {
    const clean = toolResponse('Fix the token refresh bug, see https://github.com/a/b/pull/1');
    assert.equal(redact.blockSecrets(clean, 'a test response', 'dev'), false);
  });
});
