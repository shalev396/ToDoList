/**
 * What one create (or one funnel read) runs with: the integration's credential, opened by the
 * credential vault for the duration of the call only, the headers built from it, a read client
 * for the funnel's GETs and the fetch of the created item, and the write client for the one
 * create. This module is on the vault's import allow-list (vaultImports.test.ts) and nothing
 * here keeps, logs or returns a secret: the vault refuses a result that carries one and
 * redacts what `fn` throws.
 *
 * - live mode: the live transport (netGuard; rewritten to a test's provider stand-in by
 *   services/oauth/transport.ts); the vault refreshes an expired OAuth token.
 * - fixtures mode (funnel reads only; creating is off there): the provider's recorded
 *   `create-options` fixture set and an empty secret. The vault is never called.
 */
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { createReadOnlyClient, type ReadOnlyClient, type Transport } from '../../sync/http.js';
import { fixtureTransport, loadFixtureSet } from '../../sync/transports/fixtures.js';
import { liveTransport } from '../../sync/transports/live.js';
import { fixtureSetDir } from '../../sync/fixtureSets.js';
import { syncModeFor } from '../../sync/syncMode.js';
import { decryptForSync } from '../crypto/credentialVault.js';
import { transportForIntegration } from '../oauth/transport.js';
import { LINEAR_DOCUMENTS } from '../../sync/providers/linear.js';
import { jiraSitesOf } from './jiraSites.js';
import { createWriteClient, type WriteClient } from './writeClient.js';

export const FIXTURE_SET = 'create-options';
const CREATE_TIMEOUT_MS = 12_000;
const GITHUB_API_VERSION = '2022-11-28';

/** The funnel's Linear read documents, and the one that fetches a created issue. All queries. */
export const LINEAR_CREATE_DOCUMENTS: Readonly<Record<string, string>> = {
  ...LINEAR_DOCUMENTS,
  CreateTeams: 'query CreateTeams { teams(first: 100) { nodes { id key name } } }',
  CreateProjects: `query CreateProjects($id: String!) {
  team(id: $id) { projects(first: 100) { nodes { id name } } }
}`,
  CreateStates: `query CreateStates($id: String!) {
  team(id: $id) { defaultIssueState { id } states(first: 100) { nodes { id name type position } } }
}`,
  CreatedIssue: `query CreatedIssue($id: String!) {
  issue(id: $id) {
    id identifier title description url priority dueDate estimate
    createdAt updatedAt completedAt canceledAt
    state { name type }
    team { id key name }
    project { id name }
    cycle { number name }
    assignee { id name displayName }
    labels { nodes { name } }
  }
}`,
};

export interface CreateSession {
  integration: IntegrationData;
  /** Authorization (and the provider's fixed headers) for this integration's calls. */
  headers: Record<string, string>;
  read: ReadOnlyClient;
  write: WriteClient;
  fixtures: boolean;
}

let transportFactory: (timeoutMs: number) => Transport = (timeoutMs) =>
  liveTransport({ timeoutMs });

/** Tests only (node:test): what stands in for the network; null restores the live transport. */
export function setCreateTransportForTests(
  factory: ((timeoutMs: number) => Transport) | null,
): void {
  if ((process.env['NODE_TEST_CONTEXT'] ?? '') === '') {
    throw new Error('setCreateTransportForTests runs only under node:test');
  }
  transportFactory = factory ?? ((timeoutMs): Transport => liveTransport({ timeoutMs }));
}

/** The provider's request headers from the opened secret (empty values in fixtures mode). */
export function authHeaders(
  integration: Pick<IntegrationData, 'provider'>,
  secret: Readonly<Record<string, string>>,
): Record<string, string> {
  const accessToken = secret['accessToken'];
  switch (integration.provider) {
    case 'jira':
      if (accessToken !== undefined) return { authorization: `Bearer ${accessToken}` };
      return {
        authorization: `Basic ${Buffer.from(`${secret['email'] ?? ''}:${secret['token'] ?? ''}`).toString('base64')}`,
      };
    case 'clickup':
      return {
        authorization:
          accessToken === undefined ? (secret['token'] ?? '') : `Bearer ${accessToken}`,
      };
    case 'linear':
      return {
        authorization:
          accessToken === undefined ? (secret['apiKey'] ?? '') : `Bearer ${accessToken}`,
      };
    case 'github':
      return {
        authorization: `Bearer ${secret['token'] ?? accessToken ?? ''}`,
        'x-github-api-version': GITHUB_API_VERSION,
        'user-agent': 'TodoList',
      };
    default:
      return {};
  }
}

function readClientFor(integration: IntegrationData, transport: Transport): ReadOnlyClient {
  const provider = integration.provider;
  return createReadOnlyClient({
    provider,
    transport,
    maxRetries: 1,
    ...(provider === 'linear'
      ? {
          graphql: {
            endpoint: 'https://api.linear.app/graphql',
            documents: { ...LINEAR_CREATE_DOCUMENTS },
          },
        }
      : {}),
  });
}

/**
 * Runs `fn` with a session for the integration. `reading` sessions may use recorded fixtures
 * (fixtures sync mode); a create session never does.
 */
export async function withCreateSession<T>(
  integration: IntegrationData,
  options: { reading: boolean },
  fn: (session: CreateSession) => Promise<T>,
): Promise<T> {
  if (syncModeFor(integration) === 'fixtures') {
    if (!options.reading) throw new Error('Creating is off in fixtures mode');
    const set = await loadFixtureSet(
      fixtureSetDir({ provider: integration.provider }, FIXTURE_SET),
    );
    const transport = fixtureTransport(set);
    return fn({
      integration,
      headers: {},
      read: readClientFor(integration, transport),
      write: createWriteClient(
        transport,
        integration.provider === 'jira' ? jiraSitesOf(integration).map((site) => site.base) : [],
      ),
      fixtures: true,
    });
  }
  return decryptForSync(integration.id, async (secret) => {
    const transport = transportForIntegration(transportFactory(CREATE_TIMEOUT_MS), integration);
    return fn({
      integration,
      headers: authHeaders(integration, secret),
      read: readClientFor(integration, transport),
      write: createWriteClient(
        transport,
        integration.provider === 'jira' ? jiraSitesOf(integration).map((site) => site.base) : [],
      ),
      fixtures: false,
    });
  });
}
