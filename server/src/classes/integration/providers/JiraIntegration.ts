import { AppError } from '../../../errors/AppError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import { readBackJira } from '../../../services/providerCreate/created.js';
import { readJiraTeamField } from '../../../services/providerCreate/funnel.js';
import { checkedId } from '../../../services/providerCreate/ids.js';
import { jiraSitesOf, pickJiraSite } from '../../../services/providerCreate/jiraSites.js';
import type { JiraConfig, OAuthResource } from '../../../types/integrations.js';
import type { CreateTarget } from '../../../types/providerCreate.js';
import type { ApiKeyAuth } from '../auth/ApiKeyAuth.js';
import type { OAuthAuth } from '../auth/OAuthAuth.js';
import type { Caller } from '../../base/Caller.js';
import type { ResourcePicker, SupportsApiKey, SupportsOAuth } from '../capabilities.js';
import { labelWithSite } from '../connectionTest.js';
import { JIRA, jiraAccessibleSites, type JiraSecret } from '../definitions/jira.js';
import { grantResourcesFor } from '../grantSelection.js';
import type { Integration } from '../Integration.js';
import { IntegrationRegistry } from '../IntegrationRegistry.js';
import {
  TrackerIntegration,
  type PreparedCreate,
  type TrackerWriteSession,
} from '../TrackerIntegration.js';
import { jiraIssueBody, type CreateFields } from '../writers/trackerWriter.js';

export type { JiraSecret };

/**
 * Jira: issues read from one or more sites (an OAuth grant's chosen sites through Atlassian's
 * gateway, or a token connection's one site), and created from a to-do in a project.
 */
export class JiraIntegration
  extends TrackerIntegration<JiraConfig, JiraSecret>
  implements SupportsOAuth<JiraSecret>, SupportsApiKey<JiraSecret>, ResourcePicker<'sites'>
{
  /** What Jira is: its strategies, config, rules, adapter, funnel and fixtures. */
  static readonly definition = JIRA;

  static {
    IntegrationRegistry.instance.register(JiraIntegration, (data) => new JiraIntegration(data));
  }

  private constructor(data: IntegrationData) {
    super(data);
  }

  get oauth(): OAuthAuth<JiraSecret> {
    return JiraIntegration.definition.auth.oauth;
  }

  get apiKey(): ApiKeyAuth<JiraSecret> {
    return JiraIntegration.definition.auth.apiKey;
  }

  /** An OAuth grant reaches sites to pick from; a token connection reads its one site. */
  get pickerKind(): 'sites' | null {
    return this.authKind === 'oauth' ? 'sites' : null;
  }

  /** Its owner: the sites the OAuth grant can read, live from Atlassian. */
  async pickerResources(caller: Caller): Promise<OAuthResource[]> {
    this.assertPicks(caller, this.pickerKind);
    return this.#grantSites();
  }

  /** Its owner reads exactly these sites (each one the grant covers), named as Atlassian names them. */
  async choose(caller: Caller, ids: readonly string[]): Promise<Integration> {
    this.assertPicks(caller, this.pickerKind);
    const sites = new Map((await this.#grantSites()).map((site) => [site.id, site]));
    const chosen = ids.flatMap((id) => {
      const site = sites.get(id);
      return site === undefined ? [] : [{ cloudId: site.id, url: site.url, name: site.name }];
    });
    if (ids.length === 0 || chosen.length !== ids.length) {
      throw new AppError(400, 'config.sites: not a site of this connection');
    }
    return this.update(caller, { config: { ...this.config, sites: chosen } });
  }

  /**
   * The chosen `sites` of an OAuth connection, each one the grant covers (400 otherwise). A
   * site's `url` and `name` are Atlassian's own, never kept from the request, since the url
   * becomes every issue's link.
   */
  protected override async checkSelection(
    config: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const chosen = config['sites'];
    if (this.authKind !== 'oauth' || chosen === undefined) return config;
    const grant = await grantResourcesFor(this, () => this.#grantSites());
    const byId = new Map(grant.map((resource) => [resource.id, resource]));
    const sites = (chosen as { cloudId: string }[]).map(({ cloudId }) => byId.get(cloudId));
    if (sites.some((site) => site === undefined)) {
      throw new AppError(400, 'config.sites: not a site of this connection');
    }
    return {
      ...config,
      sites: sites.map((site) => ({ cloudId: site?.id, url: site?.url, name: site?.name })),
    };
  }

  protected override learnedLabel(accountLabel: string): string {
    return labelWithSite(accountLabel, this.accountId);
  }

  /** The sites the OAuth grant reaches (its accessible resources), in a read session. */
  async #grantSites(): Promise<OAuthResource[]> {
    return this.withReadSession(async ({ secret }) =>
      (await jiraAccessibleSites(this.oauth.client(), this.oauth.headers(secret))).map((site) => ({
        id: site.cloudId,
        name: site.name,
        url: site.url,
      })),
    );
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
