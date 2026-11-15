import { AppError } from '../../../errors/AppError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import { getWorkspaceRepository } from '../../../models/index.js';
import { readBackGithub } from '../../../services/providerCreate/created.js';
import { splitRepo } from '../../../services/providerCreate/ids.js';
import { topicIdBySlug } from '../../../services/topics.js';
import { TOPIC_RULES_MAX } from '../../../services/workspaces.js';
import type { GitHubConfig } from '../../../types/integrations.js';
import type { CreateTarget } from '../../../types/providerCreate.js';
import type { ApiKeyAuth } from '../auth/ApiKeyAuth.js';
import type { OAuthAuth } from '../auth/OAuthAuth.js';
import type { SupportsApiKey, SupportsOAuth } from '../capabilities.js';
import { GITHUB, type GitHubSecret } from '../definitions/github.js';
import { IntegrationRegistry } from '../IntegrationRegistry.js';
import {
  TrackerIntegration,
  type PreparedCreate,
  type TrackerWriteSession,
} from '../TrackerIntegration.js';
import { githubIssueBody, type CreateFields } from '../writers/trackerWriter.js';

export type { GitHubSecret };

const GITHUB_API_VERSION = '2022-11-28';

/**
 * GitHub: issues and pull requests of the account's repositories (and Projects boards), and an
 * issue created in a repository, with existing labels only.
 */
export class GitHubIntegration
  extends TrackerIntegration<GitHubConfig, GitHubSecret>
  implements SupportsOAuth<GitHubSecret>, SupportsApiKey<GitHubSecret>
{
  /** What GitHub is: its strategies, config, rules, adapter, funnel and fixtures. */
  static readonly definition = GITHUB;

  static {
    IntegrationRegistry.instance.register(GitHubIntegration, (data) => new GitHubIntegration(data));
  }

  private constructor(data: IntegrationData) {
    super(data);
  }

  get oauth(): OAuthAuth<GitHubSecret> {
    return GitHubIntegration.definition.auth.oauth;
  }

  get apiKey(): ApiKeyAuth<GitHubSecret> {
    return GitHubIntegration.definition.auth.apiKey;
  }

  /** GitHub's fixed headers on every create-path call, beside the strategy's auth header. */
  protected override get providerHeaders(): Record<string, string> {
    return { 'x-github-api-version': GITHUB_API_VERSION, 'user-agent': 'TodoList' };
  }

  /**
   * The GitHub rule ("plan → GitHub connection"): a user's own repos are personal. A new
   * connection of a user account appends `<login>/* → <the personal topic>`, lower case, in one
   * atomic write (WorkspaceRepository.appendTopicRule), unless the workspace has no `personal`
   * topic, a rule with that match exists in any case or the rules are at their cap. The match is
   * audited as `topicRule` when it was added.
   */
  protected override async onConnected(): Promise<Record<string, unknown>> {
    const login = this.config.owner;
    if (this.config.ownerType !== 'user' || typeof login !== 'string') return {};
    const personal = await topicIdBySlug(this.workspaceId, 'personal');
    if (personal === null) return {};
    const match = `${login.toLowerCase()}/*`;
    const added = await (
      await getWorkspaceRepository()
    ).appendTopicRule(this.workspaceId, { match, topicId: personal }, TOPIC_RULES_MAX);
    return added ? { topicRule: match } : {};
  }

  /**
   * `config.boards.enabled` follows what the token can read, so a token without Projects access
   * doesn't fail every sync on its boards (and a new one turns them back on).
   */
  protected override readonly learnedCapabilities = { boards: 'boardsEnabled' } as const;

  protected async prepare(
    session: TrackerWriteSession,
    target: CreateTarget,
    fields: CreateFields,
  ): Promise<PreparedCreate> {
    if (target.provider !== 'github') {
      throw new AppError(400, 'target: nothing is created this way');
    }
    const { headers, write, read } = session;
    const env = { timeZone: fields.timeZone };
    const { owner, name } = splitRepo(target.repo);
    const repo = `${owner}/${name}`;
    const labels = target.labels ?? [];
    if (labels.length > 0) {
      // A label that does not exist would be created by GitHub: a second write. Never.
      const { data } = await read.getJson<{ name?: unknown }[]>(
        `https://api.github.com/repos/${owner}/${name}/labels?per_page=100`,
        headers,
      );
      const known = new Set(
        (Array.isArray(data) ? data : []).flatMap((label) =>
          typeof label.name === 'string' ? [label.name] : [],
        ),
      );
      if (!labels.every((label) => known.has(label))) {
        throw new AppError(400, 'labels: not labels of this repository');
      }
    }
    const body = githubIssueBody(fields, labels);
    return {
      write: () => write.createGithubIssue(repo, headers, body),
      readBack: (record) => readBackGithub(session, repo, record, env),
    };
  }
}
