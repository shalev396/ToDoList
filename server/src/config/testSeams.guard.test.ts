/**
 * Every test seam the server code exports throws outside node:test: a running server (Lambda or
 * src/local.ts) can never swap Cognito, KMS, S3, SES, the background sync jobs, Secrets Manager or
 * a provider for a stand-in, nor turn the rate limits off or allow loopback calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

Object.assign(process.env, {
  ENV: 'prod',
  AWS_REGION: 'us-east-1',
  COGNITO_CLIENT_ID: 'test-client',
  COGNITO_USER_POOL_ID: 'us-east-1_test',
  DOMAIN_NAME: 'example.test',
  DATABASE_URL: 'mongodb://127.0.0.1:1/unused',
});

const switches = await import('./testSwitches.js');
const { setTokenVerifierForTests } = await import('../utils/cognitoUtil.js');
const { setObjectStoreForTests } = await import('../utils/s3Util.js');
const { setMailSenderForTests } = await import('../utils/sesUtil.js');
const { setKeyProviderForTests } = await import('../services/crypto/keyProviders.js');
const { setAppSecretsForTests, resetAppSecretsForTests } =
  await import('../services/appSecrets.js');
const { setJobRunnerForTests } = await import('../services/syncJobs.js');
const { setCallbackOriginForTests } = await import('../services/oauth/common.js');
const { setOAuthTransportForTests } = await import('../services/oauth/transport.js');
const { setLiveTransportForTests } = await import('../classes/integration/connectionTest.js');
const { setCreateTransportForTests } = await import('../classes/integration/TrackerIntegration.js');
const { setGoogleBaseUrlForTests } = await import('../sync/providers/googleEndpoints.js');
const { setOAuthBaseUrlForTests } = await import('../sync/providers/oauthEndpoints.js');
const { setVaultLoaderForTests } = await import('../sync/secrets.js');

const SEAMS: Record<string, () => void> = {
  forceSyncModeForTests: () => {
    switches.forceSyncModeForTests('fixtures');
  },
  setRateLimitsOffForTests: () => {
    switches.setRateLimitsOffForTests(true);
  },
  setLoopbackAllowedForTests: () => {
    switches.setLoopbackAllowedForTests(true);
  },
  setTokenVerifierForTests: () => {
    setTokenVerifierForTests(() => Promise.resolve({ sub: 'x' }));
  },
  setObjectStoreForTests: () => {
    setObjectStoreForTests(null);
  },
  setMailSenderForTests: () => {
    setMailSenderForTests(() => Promise.resolve());
  },
  setKeyProviderForTests: () => {
    setKeyProviderForTests(null);
  },
  setAppSecretsForTests: () => {
    setAppSecretsForTests({});
  },
  resetAppSecretsForTests: () => {
    resetAppSecretsForTests();
  },
  setJobRunnerForTests: () => {
    setJobRunnerForTests(() => Promise.resolve());
  },
  setCallbackOriginForTests: () => {
    setCallbackOriginForTests('http://127.0.0.1:3000');
  },
  setOAuthTransportForTests: () => {
    setOAuthTransportForTests(null);
  },
  setLiveTransportForTests: () => {
    setLiveTransportForTests(null);
  },
  setCreateTransportForTests: () => {
    setCreateTransportForTests(null);
  },
  setGoogleBaseUrlForTests: () => {
    setGoogleBaseUrlForTests('http://127.0.0.1:3998');
  },
  setOAuthBaseUrlForTests: () => {
    setOAuthBaseUrlForTests('http://127.0.0.1:3997');
  },
  setVaultLoaderForTests: () => {
    setVaultLoaderForTests(null);
  },
};

const SRC = fileURLToPath(new URL('../', import.meta.url));

/** Tests and what only tests import: `*.test.ts`, src/testing, `__tests__` folders, test kits. */
const isTestOnly = (file: string): boolean =>
  file.endsWith('.test.ts') ||
  file.startsWith('testing/') ||
  file.split('/').includes('__tests__') ||
  file.endsWith('TestKit.ts');

/** Every .ts file under src/ (relative, forward slashes), its comments blanked. */
function sources(): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.ts')) continue;
    const text = readFileSync(path.join(SRC, entry), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    files.set(entry.split(path.sep).join('/'), text);
  }
  return files;
}

/** A call of a setter (never a reader such as forcedSyncModeForTests or keyProviderForTests). */
const SETTER_CALL = /\b(?:set|reset|clear)[A-Z]\w*ForTests\s*\(|\bforceSyncModeForTests\s*\(/g;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)'(\.{1,2}\/[^']+)'/g;

describe("test seams are out of a server's reach", () => {
  const files = sources();
  const server = [...files].filter(([file]) => !isTestOnly(file));

  it('no server module imports a test-only module (so no bundle carries one)', () => {
    const found: string[] = [];
    for (const [file, text] of server) {
      for (const [, specifier] of text.matchAll(SPECIFIER)) {
        const target = path.posix.normalize(
          path.posix.join(path.posix.dirname(file), specifier ?? ''),
        );
        if (isTestOnly(target.replace(/\.js$/, '.ts'))) found.push(`${file} imports ${target}`);
      }
    }
    assert.deepEqual(found, []);
  });

  it('no server module calls a test setter (only the definitions name one)', () => {
    const found: string[] = [];
    for (const [file, text] of server) {
      for (const match of text.matchAll(SETTER_CALL)) {
        const before = text.slice(Math.max(0, match.index - 16), match.index);
        if (!/function\s+$/.test(before)) found.push(`${file}: ${match[0]}`);
      }
    }
    assert.deepEqual(found, []);
  });
});

describe('test seams outside node:test', () => {
  for (const [name, call] of Object.entries(SEAMS)) {
    it(`${name} throws`, () => {
      const context = process.env['NODE_TEST_CONTEXT'];
      Reflect.deleteProperty(process.env, 'NODE_TEST_CONTEXT');
      try {
        assert.throws(call, /runs only under node:test/);
      } finally {
        process.env['NODE_TEST_CONTEXT'] = context;
      }
    });
  }

  it('left every switch as a server has it', () => {
    assert.equal(switches.forcedSyncModeForTests(), null);
    assert.equal(switches.rateLimitsOffForTests(), false);
    assert.equal(switches.loopbackAllowedForTests(), false);
  });
});
