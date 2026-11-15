import { AppError } from '../../../errors/AppError.js';
import { StatusNotAvailableError } from '../../../errors/StatusNotAvailableError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import type { ItemData, MirroredItemPatch } from '../../../models/definitions/Item.js';
import { getWorkspaceRepository } from '../../../models/index.js';
import { readBackGithub } from '../../../services/providerCreate/created.js';
import { checkedId, splitRepo } from '../../../services/providerCreate/ids.js';
import { asDate, asObject, asString } from '../../../sync/providers/trackerCommon.js';
import type { ItemStatus } from '../../../types/domain.js';
import { topicIdBySlug } from '../../../services/topics.js';
import { TOPIC_RULES_MAX } from '../../../services/workspaces.js';
import type { GitHubConfig, WritableField } from '../../../types/integrations.js';
import type { CreateTarget } from '../../../types/providerCreate.js';
import type { ApiKeyAuth } from '../auth/ApiKeyAuth.js';
import type { OAuthAuth } from '../auth/OAuthAuth.js';
import type { SupportsApiKey, SupportsOAuth } from '../capabilities.js';
import { GITHUB, type GitHubSecret } from '../definitions/github.js';
import { IntegrationRegistry } from '../IntegrationRegistry.js';
import {
  TrackerIntegration,
  type PreparedCreate,
  type ProviderPatch,
  type TrackerWriteSession,
  type WriteLedger,
} from '../TrackerIntegration.js';
import {
  githubIssueBody,
  githubUpdateBody,
  type CreateFields,
  type GithubIssueState,
} from '../writers/trackerWriter.js';

export type { GitHubSecret };

const GITHUB_API_VERSION = '2022-11-28';

/** An issue's state for each status; "in progress" is a board column, not the issue's own. */
const STATE_OF: Readonly<Partial<Record<ItemStatus, GithubIssueState>>> = {
  open: { state: 'open' },
  done: { state: 'closed', stateReason: 'completed' },
  cancelled: { state: 'closed', stateReason: 'not_planned' },
};

/** An issue's state as the sync reads it (gh mapping): closed as not planned is cancelled. */
function statusOfIssue(record: Record<string, unknown>): ItemStatus | null {
  const state = asString(record['state']);
  if (state === 'open') return 'open';
  if (state !== 'closed') return null;
  const reason = asString(record['state_reason']);
  return reason === 'not_planned' || reason === 'duplicate' ? 'cancelled' : 'done';
}

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

  /**
   * GitHub's own rule besides the reachable statuses: an open issue its board column marks "in
   * progress" reads as in progress; setting it to open would change nothing at GitHub and flip
   * back at the next sync (status_not_available).
   */
  protected override checkUpdate(item: ItemData, patch: ProviderPatch): void {
    super.checkUpdate(item, patch);
    const state = asString(asObject(item.props['github'])?.['state']);
    if (patch.status === 'open' && item.status === 'in_progress' && state === 'open') {
      throw new StatusNotAvailableError('github', patch.status);
    }
  }

  /**
   * A GitHub issue's write-back: one PATCH of its title and state (open; closed as completed or
   * not planned), confirmed to the ledger. GitHub answers with the issue: its title, state and
   * when it closed are what it confirms.
   */
  protected async applyUpdate(
    session: TrackerWriteSession,
    item: ItemData,
    patch: ProviderPatch,
    ledger: WriteLedger,
  ): Promise<void> {
    const github = asObject(item.props['github']);
    const { owner, name } = splitRepo(github?.['repo'], 'item');
    const number = checkedId('githubNumber', String(github?.['number']), 'item');
    let state: GithubIssueState | undefined;
    if (patch.status !== undefined) {
      state = STATE_OF[patch.status];
      if (state === undefined) throw new StatusNotAvailableError('github', patch.status);
    }
    const record = this.answerOf(
      await session.write.updateGithubIssue(
        `${owner}/${name}`,
        number,
        session.headers,
        githubUpdateBody(patch, state),
      ),
    );
    const confirmed: MirroredItemPatch = {};
    const fields: WritableField[] = [];
    if (patch.title !== undefined) {
      confirmed.title = asString(record?.['title']) ?? patch.title;
      fields.push('title');
    }
    if (patch.status !== undefined && state !== undefined) {
      const status = (record === null ? null : statusOfIssue(record)) ?? patch.status;
      const closed = status === 'done' || status === 'cancelled';
      Object.assign(confirmed, this.confirmedStatus(status, closed ? 'closed' : 'open'));
      const closedAt = asDate(record?.['closed_at']);
      if (closed && closedAt !== null) confirmed.closedAt = closedAt;
      fields.push('status');
    }
    await ledger.confirm(fields, confirmed);
  }

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
