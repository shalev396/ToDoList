/**
 * Reads a just-created item back from its provider by id (GETs through the read client, or the
 * allow-listed `CreatedIssue` query) and maps it with the provider's own sync mapper, so it can
 * be stored at once (mirror.ts). A failure here never fails the create: the next sync brings the
 * item in.
 */
import { asObject, asString } from '../../sync/providers/trackerCommon.js';
import { mapClickUpTask, type ClickUpTask } from '../../sync/providers/clickup.js';
import { mapJiraIssue, JIRA_ISSUE_FIELDS, type JiraIssue } from '../../sync/providers/jira.js';
import { mapLinearIssue, type LinearIssue } from '../../sync/providers/linear.js';
import { mapWorkItem, readRestIssue, isFailure } from '../../sync/providers/github/mapping.js';
import type { RestIssue } from '../../sync/providers/github/mapping.js';
import { OAUTH_ENDPOINTS } from '../../sync/providers/oauthEndpoints.js';
import type { MappedItem } from '../../sync/types.js';
import { checkedId, splitRepo } from './ids.js';
import { pickJiraSite } from './jiraSites.js';
import type { CreateSession } from './session.js';
import type { CreatedRecord } from './writeClient.js';

export interface ReadBackEnv {
  timeZone: string;
}

export async function readBackJira(
  session: CreateSession,
  record: CreatedRecord,
  siteId: string | undefined,
  env: ReadBackEnv,
): Promise<MappedItem | null> {
  const { integration, read, headers } = session;
  const site = pickJiraSite(integration, siteId);
  const key = record.key ?? '';
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return null;
  const base = `${site.base}/rest/api/3`;
  const { data: issue } = await read.getJson<JiraIssue>(
    `${base}/issue/${key}?fields=${JIRA_ISSUE_FIELDS}`,
    headers,
  );
  const { data: me } = await read.getJson<{ accountId?: string }>(`${base}/myself`, headers);
  const result = mapJiraIssue(issue, {
    accountId: integration.accountId,
    baseUrl: site.siteUrl,
    idPrefix: integration.authMethod === 'oauth' ? `${site.id}:` : '',
    connectedBy: integration.connectedBy,
    meAccountId: me.accountId ?? '',
    timeZone: env.timeZone,
  });
  return 'item' in result ? result.item : null;
}

export async function readBackClickup(
  session: CreateSession,
  record: CreatedRecord,
  env: ReadBackEnv,
): Promise<MappedItem | null> {
  const { integration, read, headers } = session;
  const api = OAUTH_ENDPOINTS.clickup.api;
  const id = record.id;
  if (!/^[A-Za-z0-9]{1,40}$/.test(id)) return null;
  const { data: task } = await read.getJson<ClickUpTask>(`${api}/task/${id}`, headers);
  const { data: user } = await read.getJson<{ user?: { id?: string | number } }>(
    `${api}/user`,
    headers,
  );
  const result = mapClickUpTask(task, {
    accountId: integration.accountId,
    connectedBy: integration.connectedBy,
    meId: String(user.user?.id ?? ''),
    timeZone: env.timeZone,
  });
  return 'item' in result ? result.item : null;
}

export async function readBackLinear(
  session: CreateSession,
  record: CreatedRecord,
  env: ReadBackEnv,
): Promise<MappedItem | null> {
  const { integration, read, headers } = session;
  const id = checkedId('linearId', record.id, 'id');
  const data = await read.graphql<{ issue?: LinearIssue | null }>('CreatedIssue', { id }, headers);
  const viewer = await read.graphql<{ viewer?: { id?: string } }>('Viewer', {}, headers);
  if (data.issue === undefined || data.issue === null) return null;
  const result = mapLinearIssue(data.issue, {
    accountId: integration.accountId,
    connectedBy: integration.connectedBy,
    viewerId: viewer.viewer?.id ?? '',
    timeZone: env.timeZone,
  });
  return 'item' in result ? result.item : null;
}

export async function readBackGithub(
  session: CreateSession,
  repo: string,
  record: CreatedRecord,
  env: ReadBackEnv,
): Promise<MappedItem | null> {
  const { integration, read, headers } = session;
  const { owner, name } = splitRepo(repo);
  const number = Number(record.id);
  if (!Number.isInteger(number) || number < 1) return null;
  const api = OAUTH_ENDPOINTS.github.api;
  const { data: issue } = await read.getJson<RestIssue>(
    `${api}/repos/${owner}/${name}/issues/${String(number)}`,
    headers,
  );
  const { data: repository } = await read.getJson<unknown>(
    `${api}/repos/${owner}/${name}`,
    headers,
  );
  const { data: user } = await read.getJson<unknown>(`${api}/user`, headers);
  const work = readRestIssue(issue, `${owner}/${name}`);
  if (isFailure(work)) return null;
  const mapped = mapWorkItem(
    {
      accountId: integration.accountId,
      connectedBy: integration.connectedBy,
      login: asString(asObject(user)?.['login']) ?? '',
      timeZone: env.timeZone,
    },
    work,
    { boards: [], containerExternalId: asString(asObject(repository)?.['node_id']) },
  );
  return isFailure(mapped) ? null : mapped;
}
