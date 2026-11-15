import { AppError } from '../../../errors/AppError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import { oauthClient } from '../../../services/oauth/client.js';
import { jiraAccessibleSites } from '../../../services/oauth/providers.js';
import { readBackJira } from '../../../services/providerCreate/created.js';
import { jiraOptions, readJiraTeamField } from '../../../services/providerCreate/funnel.js';
import { checkedId } from '../../../services/providerCreate/ids.js';
import { jiraSitesOf, pickJiraSite } from '../../../services/providerCreate/jiraSites.js';
import type { JiraConfig, OAuthResource } from '../../../types/integrations.js';
import type {
  CreateOptionsQuery,
  CreateOptionsResponseData,
  CreateTarget,
} from '../../../types/providerCreate.js';
import { ApiKeyAuth } from '../auth/ApiKeyAuth.js';
import type { HeaderBuilder } from '../auth/AuthStrategy.js';
import { OAuthAuth } from '../auth/OAuthAuth.js';
import type { SupportsApiKey, SupportsOAuth } from '../capabilities.js';
import { labelWithSite } from '../connectionTest.js';
import { checkGrantSelection } from '../grantSelection.js';
import { IntegrationRegistry } from '../IntegrationRegistry.js';
import {
  TrackerIntegration,
  type PreparedCreate,
  type TrackerReadSession,
  type TrackerWriteSession,
} from '../TrackerIntegration.js';
import { jiraIssueBody, type CreateFields } from '../writers/trackerWriter.js';

/** `{accessToken, refreshToken, …}` (OAuth) or `{email, token}` (an API token). */
export type JiraSecret = Readonly<{
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  scope?: string;
  email?: string;
  token?: string;
}>;

/** An OAuth grant's bearer token, or Basic with the account email and API token. */
const jiraHeaders: HeaderBuilder<JiraSecret> = (secret) => {
  const accessToken = secret.accessToken;
  if (accessToken !== undefined) return { authorization: `Bearer ${accessToken}` };
  return {
    authorization: `Basic ${Buffer.from(`${secret.email ?? ''}:${secret.token ?? ''}`).toString('base64')}`,
  };
};

/**
 * Jira: issues read from one or more sites (an OAuth grant's chosen sites through Atlassian's
 * gateway, or a token connection's one site), and created from a to-do in a project.
 */
export class JiraIntegration
  extends TrackerIntegration<JiraConfig, JiraSecret>
  implements SupportsOAuth<JiraSecret>, SupportsApiKey<JiraSecret>
{
  static readonly #oauth = new OAuthAuth<JiraSecret>({
    provider: 'jira',
    refresh: 'stored',
    headers: jiraHeaders,
  });
  static readonly #apiKey = new ApiKeyAuth<JiraSecret>({
    methods: ['api_token_basic'],
    headers: jiraHeaders,
  });

  static {
    IntegrationRegistry.instance.register('jira', (data) => new JiraIntegration(data));
  }

  protected readonly createSteps = ['site', 'project', 'issueType', 'team'] as const;

  private constructor(data: IntegrationData) {
    super(data);
  }

  get oauth(): OAuthAuth<JiraSecret> {
    return JiraIntegration.#oauth;
  }

  get apiKey(): ApiKeyAuth<JiraSecret> {
    return JiraIntegration.#apiKey;
  }

  /** The sites an OAuth grant can read, live from Atlassian, for the owner to pick from. */
  async grantResources(): Promise<OAuthResource[]> {
    return this.withReadSession(async ({ secret }) =>
      (await jiraAccessibleSites(oauthClient('jira'), secret.accessToken ?? '')).map((site) => ({
        id: site.cloudId,
        name: site.name,
        url: site.url,
      })),
    );
  }

  protected override checkSelection(
    config: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return checkGrantSelection(this.data, config, () => this.grantResources());
  }

  protected override learnedLabel(accountLabel: string): string {
    return labelWithSite(accountLabel, this.accountId);
  }

  protected readOptions(
    session: TrackerReadSession,
    query: CreateOptionsQuery,
  ): Promise<CreateOptionsResponseData> {
    return jiraOptions(session, query);
  }

  /** The write client creates only at this integration's own sites. */
  protected override writeBases(): string[] {
    return jiraSitesOf(this.data).map((site) => site.base);
  }

  protected async prepare(
    session: TrackerWriteSession,
    target: CreateTarget,
    fields: CreateFields,
  ): Promise<PreparedCreate> {
    if (target.provider !== 'jira') throw new AppError(400, 'target: nothing is created this way');
    const { integration, headers, write, read } = session;
    const env = { timeZone: fields.timeZone };
    const site = pickJiraSite(integration, target.siteId);
    const projectId = checkedId('jiraId', target.projectId, 'projectId');
    const issueTypeId = checkedId('jiraId', target.issueTypeId, 'issueTypeId');
    let teamToSend = target.team;
    if (target.team !== undefined) {
      // Only the project's own Team field may be written, and only one of its choices.
      const team = await readJiraTeamField(session, site, projectId, issueTypeId);
      const chosen = target.team;
      if (
        team?.fieldId !== chosen.fieldId ||
        (team.options.length > 0 && !team.options.some((option) => option.id === chosen.id))
      ) {
        throw new AppError(400, 'team: not the Team field of this project');
      }
      // No listed choices: nothing to verify the id against, so no team is sent.
      if (team.options.length === 0) teamToSend = undefined;
    }
    let assigneeAccountId: string | undefined;
    if (target.assignMe === true) {
      const { data } = await read.getJson<{ accountId?: string }>(
        `${site.base}/rest/api/3/myself`,
        headers,
      );
      if (typeof data.accountId === 'string') assigneeAccountId = data.accountId;
    }
    const body = jiraIssueBody(fields, {
      projectId,
      issueTypeId,
      team: teamToSend,
      assigneeAccountId,
    });
    return {
      write: () => write.createJiraIssue(site, headers, body),
      readBack: (record) => readBackJira(session, record, site.id, env),
    };
  }
}
