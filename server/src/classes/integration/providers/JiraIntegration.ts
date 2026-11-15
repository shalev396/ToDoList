import { AppError } from '../../../errors/AppError.js';
import { FieldNotWritableError } from '../../../errors/FieldNotWritableError.js';
import { StatusNotAvailableError } from '../../../errors/StatusNotAvailableError.js';
import { ValidationError } from '../../../errors/ValidationError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import type { ItemData, MirroredItemPatch } from '../../../models/definitions/Item.js';
import { readBackJira } from '../../../services/providerCreate/created.js';
import { readJiraTeamField } from '../../../services/providerCreate/funnel.js';
import { checkedId } from '../providerIds.js';
import {
  jiraSitesOf,
  pickJiraSite,
  type JiraSiteChoice,
} from '../../../services/providerCreate/jiraSites.js';
import { jiraStatus } from '../../../sync/providers/jira.js';
import {
  asObject,
  asString,
  dateOnlyDueAt,
  localDateString,
} from '../../../sync/providers/trackerCommon.js';
import type { ItemStatus } from '../../../types/domain.js';
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
  type ProviderPatch,
  type TrackerWriteSession,
  type WriteLedger,
} from '../TrackerIntegration.js';
import {
  jiraIssueBody,
  jiraPriorityName,
  jiraTransitionBody,
  jiraUpdateBody,
  type CreateFields,
} from '../writers/trackerWriter.js';

export type { JiraSecret };

/** The status category a write-back moves a Jira issue into; Jira has no "cancelled" one. */
const CATEGORY_OF: Readonly<Partial<Record<ItemStatus, string>>> = {
  open: 'new',
  in_progress: 'indeterminate',
  done: 'done',
};

/** The Jira fields a write-back PUTs, by our names: what the issue's edit screen must have. */
const JIRA_FIELD = { title: 'summary', dueAt: 'duedate', priority: 'priority' } as const;
type PutField = keyof typeof JIRA_FIELD;

/** One transition Jira lists for an issue, as a write-back reads it. */
interface JiraTransition {
  id: string;
  /** The status it leads to, by its name, and that status's category. */
  to: string | null;
  category: string | null;
  hasScreen: boolean;
  /** Its screen has a required field with no default: it can't be made without filling it in. */
  needsInput: boolean;
}

function transitionOf(raw: unknown): JiraTransition[] {
  const transition = asObject(raw);
  const id = asString(transition?.['id']);
  if (transition === null || id === null || !/^\d{1,20}$/.test(id)) return [];
  if (transition['isAvailable'] === false) return [];
  const to = asObject(transition['to']);
  const fields = Object.values(asObject(transition['fields']) ?? {}).map(asObject);
  return [
    {
      id,
      to: asString(to?.['name']),
      category: asString(asObject(to?.['statusCategory'])?.['key']),
      hasScreen: transition['hasScreen'] === true,
      needsInput: fields.some(
        (field) => field?.['required'] === true && field['hasDefaultValue'] !== true,
      ),
    },
  ];
}

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

  /** Jira's own rule besides the reachable statuses: an issue always has a priority. */
  protected override checkUpdate(item: ItemData, patch: ProviderPatch): void {
    super.checkUpdate(item, patch);
    if (patch.priority === null) throw new ValidationError('priority: a Jira issue always has one');
  }

  /**
   * A Jira issue's write-back. Both lookups come first, so nothing is written unless every part
   * can be: the issue's edit metadata (GET …/editmeta: each field on its edit screen, else
   * FieldNotWritableError; the priority's allowed id by its default name) and its transitions
   * with their fields (GET …/transitions?expand=transitions.fields: into the status's category,
   * one with no required field left to fill in, a screen-less one first; none:
   * StatusNotAvailableError). Then the fields are PUT and the transition is POSTed, each
   * confirmed to the ledger as it lands. Jira answers 204: what was sent is what it holds, read as
   * the sync reads it (a due date is that day, all day).
   */
  protected async applyUpdate(
    session: TrackerWriteSession,
    item: ItemData,
    patch: ProviderPatch,
    ledger: WriteLedger,
  ): Promise<void> {
    const { site, issueId } = this.#issueOf(item);
    const putFields = (['title', 'dueAt', 'priority'] as const).filter(
      (field) =>
        (field === 'title' ? patch.title : field === 'dueAt' ? patch.due : patch.priority) !==
        undefined,
    );
    const priorityId =
      putFields.length === 0
        ? undefined
        : await this.#editable(session, site, issueId, item, patch, putFields);
    const transition =
      patch.status === undefined
        ? null
        : await this.#transitionInto(session, site, issueId, patch.status);
    const body = jiraUpdateBody(patch, priorityId);
    if (body !== null) {
      this.answerOf(await session.write.updateJiraIssue(site, issueId, session.headers, body));
      const confirmed: MirroredItemPatch = {};
      if (patch.title !== undefined) confirmed.title = patch.title;
      if (patch.due !== undefined) {
        const due =
          patch.due === null
            ? null
            : dateOnlyDueAt(localDateString(patch.due.at, patch.timeZone), patch.timeZone);
        confirmed.dueAt = due;
        confirmed.allDay = due !== null;
      }
      if (patch.priority !== undefined) confirmed.priority = patch.priority;
      await ledger.confirm(putFields, confirmed);
    }
    if (transition !== null) {
      this.answerOf(
        await session.write.transitionJiraIssue(
          site,
          issueId,
          session.headers,
          jiraTransitionBody(transition.id),
        ),
      );
      const status = jiraStatus(transition.category) ?? patch.status ?? 'open';
      await ledger.confirm(['status'], this.confirmedStatus(status, transition.to));
    }
  }

  /**
   * The issue's edit metadata: each field to PUT must be on its edit screen (FieldNotWritableError
   * naming ours otherwise), and a priority is sent by the id the issue allows for its default
   * name (none of that name: FieldNotWritableError). The priority's id, when one is sent.
   */
  async #editable(
    session: TrackerWriteSession,
    site: JiraSiteChoice,
    issueId: string,
    item: ItemData,
    patch: ProviderPatch,
    putFields: readonly PutField[],
  ): Promise<string | undefined> {
    const { data } = await session.read.getJson<{ fields?: unknown }>(
      `${site.base}/rest/api/3/issue/${issueId}/editmeta`,
      session.headers,
    );
    const onScreen = asObject(data.fields) ?? {};
    const openIn = { provider: item.source.provider, url: item.source.url };
    const missing = putFields.filter((field) => asObject(onScreen[JIRA_FIELD[field]]) === null);
    if (missing.length > 0) throw new FieldNotWritableError('jira', missing, openIn);
    if (patch.priority === undefined || patch.priority === null) return undefined;
    const name = jiraPriorityName(patch.priority)?.toLowerCase();
    const allowed = asObject(onScreen['priority'])?.['allowedValues'];
    const match = (Array.isArray(allowed) ? (allowed as unknown[]) : [])
      .map(asObject)
      .find((value) => asString(value?.['name'])?.toLowerCase() === name);
    const id = asString(match?.['id']);
    if (id === null || !/^[A-Za-z0-9:_-]{1,128}$/.test(id)) {
      throw new FieldNotWritableError('jira', ['priority'], openIn);
    }
    return id;
  }

  /**
   * The site and issue id of an item of this integration: an OAuth grant's items carry their
   * site's cloud id (`<cloudId>:<issueId>`); a token connection reads its one site.
   */
  #issueOf(item: ItemData): { site: JiraSiteChoice; issueId: string } {
    const external = item.source.externalId;
    const at = external.lastIndexOf(':');
    const sites = jiraSitesOf(this.data);
    const site =
      this.authKind === 'oauth'
        ? sites.find((choice) => at > 0 && choice.id === external.slice(0, at))
        : sites[0];
    if (site === undefined) {
      throw new AppError(409, 'This issue’s Jira site is no longer read by this connection');
    }
    return { site, issueId: checkedId('jiraId', external.slice(at + 1), 'item') };
  }

  /**
   * The transition that moves the issue into `status`'s category: those Jira lists as available
   * whose screen has no required field left to fill in, one without a screen first, in Jira's
   * order. StatusNotAvailableError when there is none (or Jira has no such category).
   */
  async #transitionInto(
    session: TrackerWriteSession,
    site: JiraSiteChoice,
    issueId: string,
    status: ItemStatus,
  ): Promise<JiraTransition> {
    const category = CATEGORY_OF[status];
    if (category === undefined) throw new StatusNotAvailableError('jira', status);
    const { data } = await session.read.getJson<{ transitions?: unknown }>(
      `${site.base}/rest/api/3/issue/${issueId}/transitions?expand=transitions.fields`,
      session.headers,
    );
    const listed = Array.isArray(data.transitions) ? (data.transitions as unknown[]) : [];
    const into = listed
      .flatMap(transitionOf)
      .filter((entry) => entry.category === category && !entry.needsInput);
    const chosen = into.find((entry) => !entry.hasScreen) ?? into[0];
    if (chosen === undefined) throw new StatusNotAvailableError('jira', status);
    return chosen;
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
