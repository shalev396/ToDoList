/**
 * The funnel's choices (H5): the options of one step (sites, projects, issue types, a Jira Team
 * field, ClickUp workspaces, spaces, folders and lists, Linear teams, projects and states, GitHub
 * repositories and labels), given the earlier answers, for the tracker classes
 * (classes/integration/providers/*: `readOptions`). Google calendars are GoogleCalendarIntegration's.
 *
 * Every call is a GET (or an allow-listed GraphQL read) through the read client; none writes.
 * Answers are kept for a minute per user, integration and step, since a user opens the same
 * picker again and again. Names are cut and ids checked against the strict patterns: nothing a
 * provider says is trusted as a path.
 */
import { AppError } from '../../errors/AppError.js';
import { OAUTH_ENDPOINTS } from '../../sync/providers/oauthEndpoints.js';
import { asObject, asString } from '../../sync/providers/trackerCommon.js';
import type {
  CreateOption,
  CreateOptionsQuery,
  CreateOptionsResponseData,
} from '../../types/providerCreate.js';
import { checkedId, isValidId, splitRepo } from './ids.js';
import type { TrackerReadSession as CreateSession } from '../../classes/integration/TrackerIntegration.js';
import { jiraSitesOf, pickJiraSite } from './jiraSites.js';

const CACHE_MS = 60_000;
const CACHE_MAX = 500;
const NAME_MAX = 200;
const PAGE_CAP = 100;

const cache = new Map<string, { at: number; value: CreateOptionsResponseData }>();

function remember(key: string, value: CreateOptionsResponseData): CreateOptionsResponseData {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * One step's options for a user: the answer kept for a minute under `key` (user, integration and
 * step), else `compute`'s.
 */
export async function cachedCreateOptions(
  key: string,
  compute: () => Promise<CreateOptionsResponseData>,
): Promise<CreateOptionsResponseData> {
  const hit = cache.get(key);
  if (hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.value;
  return remember(key, await compute());
}

/** Tests only: forgets every kept answer. */
export function clearFunnelCacheForTests(): void {
  cache.clear();
}

const name = (value: unknown, fallback: string): string =>
  (asString(value) ?? fallback).slice(0, NAME_MAX);

const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? (value as unknown[]).flatMap((entry) => {
        const record = asObject(entry);
        return record === null ? [] : [record];
      })
    : [];

const idOf = (value: unknown): string | null =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : null;

// ─── Jira ───────────────────────────────────────────────────────────────────

/**
 * The project's Team field on the create screen of an issue type: its field id and choices, or
 * null when it has none. A create may only name this field (never another custom field).
 */
export async function readJiraTeamField(
  session: CreateSession,
  site: { base: string },
  projectId: string,
  issueTypeId: string,
): Promise<{ fieldId: string; options: CreateOption[] } | null> {
  const { data: raw } = await session.read.getJson<unknown>(
    `${site.base}/rest/api/3/issue/createmeta/${projectId}/issuetypes/${issueTypeId}`,
    session.headers,
  );
  const data = asObject(raw);
  const field = list(data?.['values'] ?? data?.['fields']).find((candidate) => {
    const custom = asString(asObject(candidate['schema'])?.['custom']) ?? '';
    return (
      isValidId('jiraField', candidate['fieldId'] ?? candidate['key']) &&
      (/team/i.test(custom) || asString(candidate['name'])?.toLowerCase() === 'team')
    );
  });
  if (field === undefined) return null;
  const options = list(field['allowedValues']).flatMap((value) => {
    const id = idOf(value['id']) ?? idOf(value['value']);
    if (!isValidId('opaque', id)) return [];
    return [{ id, name: name(value['name'] ?? value['title'] ?? value['value'], id) }];
  });
  return { fieldId: (field['fieldId'] ?? field['key']) as string, options };
}

export async function jiraOptions(
  session: CreateSession,
  query: CreateOptionsQuery,
): Promise<CreateOptionsResponseData> {
  const { integration, read, headers } = session;
  if (query.step === 'site') {
    return {
      options: jiraSitesOf(integration).map(({ id, name: label }) => ({ id, name: label })),
    };
  }
  const site = pickJiraSite(integration, query.siteId);
  const get = async <T>(path: string): Promise<T> =>
    (await read.getJson<T>(`${site.base}/rest/api/3${path}`, headers)).data;
  if (query.step === 'project') {
    const data = asObject(
      await get<unknown>(
        `/project/search?action=create&orderBy=name&maxResults=${String(PAGE_CAP)}`,
      ),
    );
    return {
      options: list(data?.['values']).flatMap((project) => {
        const id = idOf(project['id']);
        if (!isValidId('jiraId', id)) return [];
        const key = asString(project['key']);
        return [{ id, name: name(project['name'], id), ...(key === null ? {} : { hint: key }) }];
      }),
    };
  }
  const projectId = checkedId('jiraId', query.projectId, 'projectId');
  if (query.step === 'issueType') {
    const data = asObject(await get<unknown>(`/issue/createmeta/${projectId}/issuetypes`));
    const types = list(data?.['issueTypes'] ?? data?.['values']);
    return {
      options: types.flatMap((type) => {
        const id = idOf(type['id']);
        if (!isValidId('jiraId', id) || type['subtask'] === true) return [];
        return [{ id, name: name(type['name'], id) }];
      }),
    };
  }
  if (query.step === 'team') {
    const issueTypeId = checkedId('jiraId', query.issueTypeId, 'issueTypeId');
    const team = await readJiraTeamField(session, site, projectId, issueTypeId);
    return team ?? { options: [], fieldId: null };
  }
  throw new AppError(400, 'step: not a Jira step');
}

// ─── ClickUp ────────────────────────────────────────────────────────────────

export async function clickupOptions(
  session: CreateSession,
  query: CreateOptionsQuery,
): Promise<CreateOptionsResponseData> {
  const { read, headers, integration } = session;
  const api = OAUTH_ENDPOINTS.clickup.api;
  const get = async (path: string): Promise<Record<string, unknown>> =>
    asObject((await read.getJson<unknown>(`${api}${path}`, headers)).data) ?? {};
  const named = (items: Record<string, unknown>[]): CreateOption[] =>
    items.flatMap((entry) => {
      const id = idOf(entry['id']);
      return isValidId('clickupId', id) ? [{ id, name: name(entry['name'], id) }] : [];
    });
  switch (query.step) {
    case 'workspace': {
      const chosen = integration.config['teamIds'];
      const only = Array.isArray(chosen) ? new Set((chosen as unknown[]).map(String)) : null;
      return {
        options: named(list((await get('/team'))['teams'])).filter(
          (team) => only === null || only.has(team.id),
        ),
      };
    }
    case 'space': {
      const id = checkedId('clickupId', query.workspaceId, 'workspaceId');
      return { options: named(list((await get(`/team/${id}/space?archived=false`))['spaces'])) };
    }
    case 'folder': {
      const id = checkedId('clickupId', query.spaceId, 'spaceId');
      return { options: named(list((await get(`/space/${id}/folder?archived=false`))['folders'])) };
    }
    case 'list': {
      if (query.folderId !== undefined) {
        const id = checkedId('clickupId', query.folderId, 'folderId');
        return { options: named(list((await get(`/folder/${id}/list?archived=false`))['lists'])) };
      }
      const id = checkedId('clickupId', query.spaceId, 'spaceId');
      return { options: named(list((await get(`/space/${id}/list?archived=false`))['lists'])) };
    }
    default:
      throw new AppError(400, 'step: not a ClickUp step');
  }
}

// ─── Linear ─────────────────────────────────────────────────────────────────

export async function linearOptions(
  session: CreateSession,
  query: CreateOptionsQuery,
): Promise<CreateOptionsResponseData> {
  const { read, headers } = session;
  const nodes = (value: unknown): Record<string, unknown>[] => list(asObject(value)?.['nodes']);
  if (query.step === 'linearTeam') {
    const data = await read.graphql<Record<string, unknown>>('CreateTeams', {}, headers);
    return {
      options: nodes(data['teams']).flatMap((team) => {
        const id = idOf(team['id']);
        if (!isValidId('linearId', id)) return [];
        const key = asString(team['key']);
        return [{ id, name: name(team['name'], id), ...(key === null ? {} : { hint: key }) }];
      }),
    };
  }
  const teamId = checkedId('linearId', query.linearTeamId, 'linearTeamId');
  if (query.step === 'linearProject') {
    const data = await read.graphql<Record<string, unknown>>(
      'CreateProjects',
      { id: teamId },
      headers,
    );
    return {
      options: nodes(asObject(data['team'])?.['projects']).flatMap((project) => {
        const id = idOf(project['id']);
        return isValidId('linearId', id) ? [{ id, name: name(project['name'], id) }] : [];
      }),
    };
  }
  if (query.step === 'state') {
    const data = await read.graphql<Record<string, unknown>>(
      'CreateStates',
      { id: teamId },
      headers,
    );
    const team = asObject(data['team']);
    const defaultId = idOf(asObject(team?.['defaultIssueState'])?.['id']);
    return {
      options: nodes(team?.['states']).flatMap((state) => {
        const id = idOf(state['id']);
        if (!isValidId('linearId', id)) return [];
        return [
          { id, name: name(state['name'], id), ...(id === defaultId ? { hint: 'default' } : {}) },
        ];
      }),
    };
  }
  throw new AppError(400, 'step: not a Linear step');
}

// ─── GitHub ─────────────────────────────────────────────────────────────────

export async function githubOptions(
  session: CreateSession,
  query: CreateOptionsQuery,
): Promise<CreateOptionsResponseData> {
  const { read, headers, integration } = session;
  const api = OAUTH_ENDPOINTS.github.api;
  const get = async (path: string): Promise<unknown> =>
    (await read.getJson<unknown>(`${api}${path}`, headers)).data;
  if (query.step === 'repo') {
    const repos: Record<string, unknown>[] = [];
    if (integration.authMethod === 'oauth') {
      // A GitHub App's user token reaches the repositories of its installations.
      const installations = list(
        asObject(await get('/user/installations?per_page=20'))?.['installations'],
      );
      for (const installation of installations.slice(0, 5)) {
        const id = idOf(installation['id']);
        if (!isValidId('clickupId', id)) continue;
        repos.push(
          ...list(
            asObject(
              await get(`/user/installations/${id}/repositories?per_page=${String(PAGE_CAP)}`),
            )?.['repositories'],
          ),
        );
      }
    } else {
      repos.push(...list(await get(`/user/repos?per_page=${String(PAGE_CAP)}&sort=pushed`)));
    }
    return {
      options: repos.flatMap((repo) => {
        const full = asString(repo['full_name']);
        if (full === null || repo['archived'] === true || repo['has_issues'] === false) return [];
        try {
          splitRepo(full);
        } catch {
          return [];
        }
        return [{ id: full, name: full }];
      }),
    };
  }
  if (query.step === 'label') {
    const { owner, name: repo } = splitRepo(query.repo);
    const labels = list(await get(`/repos/${owner}/${repo}/labels?per_page=${String(PAGE_CAP)}`));
    return {
      options: labels.flatMap((label) => {
        const text = asString(label['name']);
        return text === null ? [] : [{ id: text.slice(0, 50), name: text.slice(0, 50) }];
      }),
    };
  }
  throw new AppError(400, 'step: not a GitHub step');
}
