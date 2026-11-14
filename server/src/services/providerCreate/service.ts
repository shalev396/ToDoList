/**
 * Creating a local to-do in the caller's own providers too (H5, D19): the one place TodoList
 * writes to a provider, and only to CREATE one item after an explicit user action.
 *
 * Gates, in order: an editor or above; the to-do is the caller's own; the integration is the
 * caller's own (anyone else's is a 404); creating is on for it on this server (mode.ts); a to-do
 * with a copy already pending, created or unknown at this integration answers that copy instead
 * of making another (unless `retryAnyway`); the caller is under the hourly limit, reserved
 * atomically BEFORE the provider is called; the same `requestId` never creates twice. Then the
 * typed request goes through the write client (writeClient.ts). A request that was sent and got
 * no answer is `unknown` and is never retried.
 *
 * Right after the provider answers, the create is audited and the copy's status recorded (no
 * title or token in the entry). Reading the item back and storing it as a mirrored copy come
 * after, best effort and under a short budget: they never change what is reported.
 */
import { LIMITS } from '../../config/limits.js';
import { AppError } from '../../errors/AppError.js';
import { CalendarApiError, type PlainEventBody } from '../../gcal/calendarApi.js';
import { insertOAuthEvent } from '../../gcal/oauthCalendar.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import {
  effectiveCopyStatus,
  type ItemCopy,
  type ItemData,
} from '../../models/definitions/Item.js';
import {
  getAuditLogRepository,
  getCreateQuotaRepository,
  getCredentialRepository,
  getIntegrationRepository,
  getItemRepository,
} from '../../models/index.js';
import { ProviderHttpError } from '../../sync/http.js';
import { mapCalendarEvent } from '../../sync/providers/google_calendar.js';
import type { MappedItem } from '../../sync/types.js';
import type { ItemCopyView } from '../../types/items.js';
import {
  CREATABLE_PROVIDERS,
  type CreatableProvider,
  type CreateCopyOutcome,
  type CreateCopyRequestBody,
  type CreateFailure,
  type CreateOptionsQuery,
  type CreateOptionsResponseData,
  type CreateTarget,
  type CreateTargetsResponseData,
} from '../../types/providerCreate.js';
import type { WorkspaceContext } from '../accessFilter.js';
import { sha256Hex } from '../crypto/hashing.js';
import { assertRole, type IntegrationActor } from '../integrations.js';
import { findOwnIntegration, isOwnIntegration } from '../integrationOwnership.js';
import { isIntegrationShared } from '../itemAccess.js';
import { logger } from '../logger.js';
import { isOAuthProviderId, OAUTH_PROVIDER_DEFS } from '../oauth/providers.js';
import { readBackClickup, readBackGithub, readBackJira, readBackLinear } from './created.js';
import { readCreateOptions, readJiraTeamField } from './funnel.js';
import { checkedId, splitRepo } from './ids.js';
import { jiraSitesOf, pickJiraSite } from './jiraSites.js';
import { markAsCopy, storeMirroredItem } from './mirror.js';
import { writeModeFor } from './mode.js';
import { withCreateSession, type CreateSession } from './session.js';
import {
  cleanTitle,
  clickupTaskBody,
  githubIssueBody,
  jiraIssueBody,
  linearIssueInput,
  type CreateFields,
  type CreatedRecord,
  type WriteResult,
} from './writeClient.js';

const AUDIT_ACTION = 'provider.create';
const HOUR_MS = 60 * 60 * 1000;
/** The read-back and the mirror each may take this long; then the create is reported as is. */
const READ_BACK_BUDGET_MS = 5_000;
const GITHUB_INSTALLATIONS_URL = 'https://github.com/settings/installations';
const NOTE_MAX = 500;

export const isCreatableProvider = (value: string): value is CreatableProvider =>
  (CREATABLE_PROVIDERS as readonly string[]).includes(value);

// ─── what the chips show ────────────────────────────────────────────────────

/** Does this OAuth Jira or Linear grant lack the scope that creates items? */
async function lacksWriteScope(integration: IntegrationData): Promise<boolean> {
  const { provider } = integration;
  if (integration.authMethod !== 'oauth' || !isOAuthProviderId(provider)) return false;
  const needed = OAUTH_PROVIDER_DEFS[provider].writeScopes;
  if (needed.length === 0) return false;
  const meta = await (
    await getCredentialRepository()
  ).findMeta(integration.workspaceId, integration.id);
  const granted = new Set(meta?.scopes ?? []);
  return needed.some((scope) => !granted.has(scope));
}

/** The caller's own integrations that can create items, one chip each. */
export async function listCreateTargets(
  ctx: WorkspaceContext,
  userId: string,
): Promise<CreateTargetsResponseData> {
  const integrations = await (await getIntegrationRepository()).list(ctx.id);
  const targets: CreateTargetsResponseData['targets'] = [];
  for (const integration of integrations) {
    const { provider } = integration;
    if (
      !isCreatableProvider(provider) ||
      !isOwnIntegration(integration, userId) ||
      integration.status !== 'active'
    ) {
      continue;
    }
    // Calendar events need an OAuth grant.
    if (provider === 'google_calendar' && integration.authMethod !== 'oauth') continue;
    targets.push({
      integrationId: integration.id,
      provider,
      label: integration.label,
      authMethod: integration.authMethod,
      needsConsent: await lacksWriteScope(integration),
      writable: writeModeFor(integration) !== 'off',
      shared: await isIntegrationShared(integration),
    });
  }
  return { targets };
}

/** The caller's own integration, or a 404 (someone else's, or not there). */
async function ownIntegration(
  ctx: WorkspaceContext,
  userId: string,
  integrationId: string,
): Promise<IntegrationData> {
  return findOwnIntegration(ctx, userId, integrationId);
}

const writesOff = (): AppError =>
  new AppError(409, 'Creating in providers is off on this server', { code: 'provider_writes_off' });

/** One funnel step's choices. Editor or above; the integration is the caller's own and writable. */
export async function createOptions(
  ctx: WorkspaceContext,
  userId: string,
  integrationId: string,
  query: CreateOptionsQuery,
): Promise<CreateOptionsResponseData> {
  assertRole(ctx, 'editor');
  const integration = await ownIntegration(ctx, userId, integrationId);
  if (!isCreatableProvider(integration.provider)) {
    throw new AppError(409, 'Nothing can be created in this provider');
  }
  // Nothing is read at a provider that cannot be written to.
  if (writeModeFor(integration) === 'off') throw writesOff();
  try {
    return await readCreateOptions(integration, userId, query);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof ProviderHttpError && error.code === 'auth_failed') {
      throw new AppError(409, `${integration.provider} refused the connection: reconnect it`);
    }
    logger.warn('Create options could not be read', {
      integrationId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw new AppError(502, `${integration.provider} did not answer. Try again in a moment.`);
  }
}

// ─── the create ─────────────────────────────────────────────────────────────

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** A link from a provider's answer: https, on the provider's own host; else nothing. */
export function safeCopyUrl(
  integration: Pick<IntegrationData, 'provider' | 'authMethod' | 'config'>,
  url: string | null,
): string {
  if (url === null) return '';
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return '';
    host = parsed.hostname.toLowerCase();
  } catch {
    return '';
  }
  const on = (domain: string): boolean => host === domain || host.endsWith(`.${domain}`);
  switch (integration.provider) {
    case 'jira':
      return jiraSitesOf(integration).some((site) => hostOf(site.siteUrl) === host) ? url : '';
    case 'clickup':
      return on('clickup.com') ? url : '';
    case 'linear':
      return on('linear.app') ? url : '';
    case 'github':
      return on('github.com') ? url : '';
    case 'google_calendar':
      return on('google.com') ? url : '';
    default:
      return '';
  }
}

function viewOf(copy: ItemCopy, now: Date = new Date()): ItemCopyView {
  return {
    integrationId: copy.integrationId,
    provider: copy.provider as ItemCopyView['provider'],
    key: copy.key,
    url: copy.url,
    status: effectiveCopyStatus(copy, now),
    liveStatus: null,
    requestId: copy.requestId,
  };
}

/** The outcome a stored copy stands for (a repeat of a request answers with it). */
function outcomeOf(copy: ItemCopy): CreateCopyOutcome {
  const view = viewOf(copy);
  if (copy.status === 'created') return { status: 'created', copy: view };
  if (copy.status === 'failed') return { status: 'failed', reason: 'rejected', copy: view };
  return { status: 'unknown', copy: { ...view, status: 'unknown' } };
}

const hourStartOf = (now: Date): Date => new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);

type AuditResult = 'created' | 'unknown' | 'refused' | 'not_sent';

/** One audit entry per create attempt that reached a decision: provider, result, key; no content. */
async function auditCreate(
  ctx: WorkspaceContext,
  actor: IntegrationActor,
  integration: IntegrationData,
  result: AuditResult,
  record: CreatedRecord | null,
): Promise<void> {
  try {
    await (
      await getAuditLogRepository()
    ).append(ctx.id, {
      actorUserId: actor.userId,
      actorAgentId: actor.agentId,
      action: AUDIT_ACTION,
      targetType: 'integration',
      targetId: integration.id,
      meta: {
        provider: integration.provider,
        result,
        ...(record === null ? {} : { externalKey: record.key ?? record.id }),
      },
    });
  } catch (error) {
    logger.error('A provider create could not be audited', {
      integrationId: integration.id,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

function fieldsOf(todo: ItemData, ctx: WorkspaceContext): CreateFields {
  return {
    title: todo.title,
    description: todo.bodyPreview === null ? null : todo.bodyPreview.slice(0, NOTE_MAX),
    dueAt: todo.dueAt,
    allDay: todo.allDay,
    priority: todo.priority,
    timeZone: ctx.settings.timezone,
  };
}

async function loadTodo(ctx: WorkspaceContext, userId: string, id: string): Promise<ItemData> {
  const todo = await (await getItemRepository()).findById(ctx.id, id);
  if (todo?.source.provider !== 'local' || todo.ownerUserId !== userId) {
    throw new AppError(404, 'Not found');
  }
  return todo;
}

function assertTargetMatches(integration: IntegrationData, target: CreateTarget): void {
  if (integration.provider !== target.provider) {
    throw new AppError(400, 'target: not a target of this integration');
  }
}

/** A request already prepared (validated, built) and ready to send, with its read-back. */
interface Prepared {
  write: () => Promise<WriteResult>;
  readBack: (record: CreatedRecord) => Promise<MappedItem | null>;
}

/** Validates the target and builds the one create for this provider. Throws AppError (400) before anything is sent. */
async function prepare(
  ctx: WorkspaceContext,
  session: CreateSession,
  target: CreateTarget,
  fields: CreateFields,
): Promise<Prepared> {
  const { integration, headers, write, read } = session;
  const env = { timeZone: ctx.settings.timezone };
  switch (target.provider) {
    case 'jira': {
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
    case 'clickup': {
      const listId = checkedId('clickupId', target.listId, 'listId');
      const body = clickupTaskBody(fields);
      return {
        write: () => write.createClickupTask(listId, headers, body),
        readBack: (record) => readBackClickup(session, record, env),
      };
    }
    case 'linear': {
      const input = linearIssueInput(fields, target);
      return {
        write: () => write.createLinearIssue(headers, input),
        readBack: (record) => readBackLinear(session, record, env),
      };
    }
    case 'github': {
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
    default:
      throw new AppError(400, 'target: nothing is created this way');
  }
}

/** The failure a refusal is, in the words the UI maps. */
export function failureFor(
  integration: IntegrationData,
  reason: Extract<WriteResult, { kind: 'refused' }>['reason'],
): CreateFailure | 'needs_permission' {
  switch (reason) {
    case 'auth':
      return 'auth_failed';
    case 'rate_limited':
      return 'rate_limited';
    case 'unreachable':
      return 'unreachable';
    case 'forbidden':
      if (integration.provider === 'github' && integration.authMethod === 'oauth') {
        return 'needs_permission';
      }
      return integration.authMethod === 'oauth' ? 'rejected' : 'token_cannot_create';
    default:
      return 'rejected';
  }
}

/** Plain event for a to-do with a due date: all day, or a half hour from its time. */
function calendarEvent(
  todo: ItemData,
  fields: CreateFields,
  eventId: string,
): PlainEventBody | null {
  const summary = cleanTitle(fields.title);
  if (todo.dueAt === null || summary === null) return null;
  const description = fields.description ?? '';
  if (todo.allDay) {
    const day = todo.dueAt.toLocaleDateString('en-CA', { timeZone: fields.timeZone });
    const next = new Date(`${day}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return {
      id: eventId,
      summary,
      description,
      start: { date: day },
      end: { date: next.toISOString().slice(0, 10) },
      status: 'confirmed',
    };
  }
  const end = new Date(todo.dueAt.getTime() + 30 * 60 * 1000);
  return {
    id: eventId,
    summary,
    description,
    start: { dateTime: todo.dueAt.toISOString(), timeZone: fields.timeZone },
    end: { dateTime: end.toISOString(), timeZone: fields.timeZone },
    status: 'confirmed',
  };
}

/** Google event ids are base32hex: a stable one per request makes a repeat the same event. */
const eventIdFor = (requestId: string): string => `h5${sha256Hex(requestId).slice(0, 40)}`;

/** `work`, or null when it is not done in `ms` or fails (it keeps running; its answer is dropped). */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, ms);
  });
  try {
    return await Promise.race([work.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Creates the to-do's copy in one provider. Editor or above, the caller's own to-do and
 * integration. 409 `provider_writes_off` when creating is off for it here, 429
 * `create_rate_limited` past the hourly limit, 400 for a bad target, `needs_due_date` for a
 * calendar event without a due date. Everything the provider decides comes back as an outcome.
 */
export async function createCopy(
  ctx: WorkspaceContext,
  actor: IntegrationActor,
  todoId: string,
  body: CreateCopyRequestBody,
  now: Date = new Date(),
): Promise<CreateCopyOutcome> {
  assertRole(ctx, 'editor');
  const requestId = checkedId('requestId', body.requestId, 'requestId');
  const todo = await loadTodo(ctx, actor.userId, todoId);
  const integration = await ownIntegration(ctx, actor.userId, body.integrationId);
  if (!isCreatableProvider(integration.provider)) {
    throw new AppError(409, 'Nothing can be created in this provider');
  }
  assertTargetMatches(integration, body.target);
  const isCalendar = integration.provider === 'google_calendar';
  if (isCalendar && integration.authMethod !== 'oauth') {
    throw new AppError(409, 'Only Google Calendar connected with Google can create events');
  }

  // A repeat of a request answers with what it did: it never creates twice.
  const known = todo.copies.find((copy) => copy.requestId === requestId);
  if (known !== undefined) return outcomeOf(known);
  // Another request id for a to-do that already has a copy here that may exist: the same answer,
  // unless the user said "retry anyway".
  const active = todo.copies.find(
    (copy) =>
      copy.integrationId === integration.id &&
      (copy.status === 'pending' || copy.status === 'created' || copy.status === 'unknown'),
  );
  if (active !== undefined && body.retryAnyway !== true) return outcomeOf(active);

  if (writeModeFor(integration) === 'off') throw writesOff();
  const fields = fieldsOf(todo, ctx);
  if (isCalendar && todo.dueAt === null) {
    throw new AppError(400, 'A calendar event needs a due date', { code: 'needs_due_date' });
  }

  // Reserve the hourly budget before anything is sent; give it back only for a definite "no".
  const quotas = await getCreateQuotaRepository();
  const hourStart = hourStartOf(now);
  const reservedOk = await quotas.reserve(
    actor.userId,
    integration.provider,
    hourStart,
    LIMITS.providerCreatesPerHour,
  );
  if (!reservedOk) {
    throw new AppError(429, 'Too many items created in this provider this hour. Try again later.', {
      code: 'create_rate_limited',
    });
  }
  let reserved = true;
  const release = async (): Promise<void> => {
    if (!reserved) return;
    reserved = false;
    await quotas.release(actor.userId, integration.provider, hourStart).catch(() => undefined);
  };

  const items = await getItemRepository();
  // A new attempt replaces this integration's earlier failed one.
  try {
    for (const copy of todo.copies) {
      if (copy.integrationId === integration.id && copy.status === 'failed') {
        await items.removeCopy(ctx.id, todo.id, copy.requestId);
      }
    }
  } catch (error) {
    await release();
    throw error;
  }
  const pending: ItemCopy = {
    integrationId: integration.id,
    provider: integration.provider,
    externalId: '',
    key: null,
    url: '',
    status: 'pending',
    requestId,
    at: now,
  };
  let claimed: boolean;
  try {
    // Atomic per to-do and integration: another request that got here first wins.
    claimed = await items.addCopy(ctx.id, todo.id, pending, {
      allowActive: body.retryAnyway === true,
    });
  } catch (error) {
    await release();
    throw error;
  }
  if (!claimed) {
    await release();
    const again = await loadTodo(ctx, actor.userId, todoId);
    const existing =
      again.copies.find((copy) => copy.requestId === requestId) ??
      again.copies.find(
        (copy) =>
          copy.integrationId === integration.id &&
          (copy.status === 'pending' || copy.status === 'created' || copy.status === 'unknown'),
      );
    if (existing !== undefined) return outcomeOf(existing);
    throw new AppError(404, 'Not found');
  }
  const finish = async (
    patch: Partial<Pick<ItemCopy, 'externalId' | 'key' | 'url' | 'status'>>,
  ): Promise<ItemCopy> => {
    try {
      const updated = await items.updateCopy(ctx.id, todo.id, requestId, patch);
      return (
        updated?.copies.find((copy) => copy.requestId === requestId) ?? { ...pending, ...patch }
      );
    } catch (error) {
      logger.error('A copy could not be updated', {
        integrationId: integration.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return { ...pending, ...patch };
    }
  };
  const fail = async (reason: CreateFailure, audit: AuditResult): Promise<CreateCopyOutcome> => {
    await release();
    await auditCreate(ctx, actor, integration, audit, null);
    return { status: 'failed', reason, copy: viewOf(await finish({ status: 'failed' })) };
  };

  let needsScope: boolean;
  try {
    needsScope = await lacksWriteScope(integration);
  } catch (error) {
    await release();
    await items.removeCopy(ctx.id, todo.id, requestId).catch(() => undefined);
    throw error;
  }
  if (needsScope) {
    await release();
    const copy = await finish({ status: 'failed' });
    return {
      status: 'needs_permission',
      kind: 'oauth_scope',
      settingsUrl: null,
      copy: viewOf(copy),
    };
  }

  const state: { result: WriteResult | null; mapped: MappedItem | null } = {
    result: null,
    mapped: null,
  };
  /** Records what the provider answered, at once: the audit entry and the copy's status. */
  const settle = async (result: WriteResult): Promise<void> => {
    state.result = result;
    if (result.kind === 'created') {
      await auditCreate(ctx, actor, integration, 'created', result.record);
      await finish({
        status: 'created',
        externalId: result.record.id,
        key: result.record.key,
        url: safeCopyUrl(integration, result.record.url),
      });
    } else if (result.kind === 'unknown') {
      await auditCreate(ctx, actor, integration, 'unknown', null);
      await finish({ status: 'unknown' });
    } else {
      await release();
      await auditCreate(ctx, actor, integration, 'refused', null);
      await finish({ status: 'failed' });
    }
  };

  try {
    if (isCalendar && body.target.provider === 'google_calendar') {
      const calendarId = checkedId('calendarId', body.target.calendarId, 'calendarId');
      const event = calendarEvent(todo, fields, eventIdFor(requestId));
      if (event === null) {
        throw new AppError(400, 'A calendar event needs a title and a due date');
      }
      const result = await sendCalendar(integration, calendarId, event);
      await settle(result);
      if (result.kind === 'created') {
        state.mapped = readBackCalendar(ctx, integration, calendarId, event, result);
      }
    } else {
      await withCreateSession(integration, { reading: false }, async (session): Promise<void> => {
        const prepared = await prepare(ctx, session, body.target, fields);
        const result = await prepared.write();
        await settle(result);
        if (result.kind === 'created') {
          // Best effort: one attempt, a short budget; the create is already recorded.
          state.mapped = await within(prepared.readBack(result.record), READ_BACK_BUDGET_MS);
        }
      });
    }
  } catch (error) {
    if (state.result !== null) {
      // After the provider answered: nothing here changes what happened.
      logger.warn('A created item could not be read back', {
        integrationId: integration.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    } else if (error instanceof AppError) {
      await release();
      await items.removeCopy(ctx.id, todo.id, requestId);
      throw error;
    } else {
      logger.warn('A provider create failed before it was sent', {
        integrationId: integration.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return fail(
        error instanceof ProviderHttpError && error.code === 'auth_failed'
          ? 'auth_failed'
          : 'unreachable',
        'not_sent',
      );
    }
  }

  const { result, mapped } = state;
  if (result === null) return fail('unreachable', 'not_sent');
  if (result.kind === 'unknown') {
    return { status: 'unknown', copy: viewOf({ ...pending, status: 'unknown' }) };
  }
  if (result.kind === 'refused') {
    const failure = failureFor(integration, result.reason);
    const copy = viewOf({ ...pending, status: 'failed' });
    if (failure === 'needs_permission') {
      return {
        status: 'needs_permission',
        kind: 'github_app',
        settingsUrl: GITHUB_INSTALLATIONS_URL,
        copy,
      };
    }
    return { status: 'failed', reason: failure, copy };
  }

  // Created: store the item at once behind its to-do, best effort.
  const { record } = result;
  let externalId = record.id;
  try {
    const stored =
      mapped === null
        ? null
        : await within(storeMirroredItem(integration, mapped), READ_BACK_BUDGET_MS);
    if (stored !== null) {
      // The to-do's sharing is read now: it may have changed during the create.
      const fresh = await items.findById(ctx.id, todo.id);
      if (fresh !== null) await markAsCopy(ctx.id, stored.id, fresh);
      externalId = stored.source.externalId;
      await finish({ externalId });
    }
  } catch (error) {
    logger.warn('A created item could not be stored at once', {
      integrationId: integration.id,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
  return {
    status: 'created',
    copy: viewOf({
      ...pending,
      status: 'created',
      externalId,
      key: record.key,
      url: safeCopyUrl(integration, record.url),
    }),
  };
}

// ─── Google Calendar ────────────────────────────────────────────────────────

async function sendCalendar(
  integration: IntegrationData,
  calendarId: string,
  event: PlainEventBody,
): Promise<WriteResult> {
  try {
    const written = await insertOAuthEvent(integration, calendarId, event);
    const eid = Buffer.from(`${written.id} ${calendarId}`).toString('base64url');
    return {
      kind: 'created',
      record: {
        id: written.id,
        key: null,
        url: `https://calendar.google.com/calendar/event?eid=${eid}`,
      },
    };
  } catch (error) {
    // Only an answer from Google is about the event; a grant or refresh that fails before
    // anything is sent is not, so it propagates (and is reported as not sent).
    if (!(error instanceof CalendarApiError)) throw error;
    const { status } = error;
    if (status === null || status >= 500) return { kind: 'unknown' };
    if (status === 401) return { kind: 'refused', reason: 'auth' };
    if (status === 403) return { kind: 'refused', reason: 'forbidden' };
    if (status === 429) return { kind: 'refused', reason: 'rate_limited' };
    return { kind: 'refused', reason: 'rejected' };
  }
}

/** The event as the calendar sync maps it, stored at once. */
function readBackCalendar(
  ctx: WorkspaceContext,
  integration: IntegrationData,
  calendarId: string,
  event: PlainEventBody,
  result: WriteResult,
): MappedItem | null {
  if (result.kind !== 'created') return null;
  const mapped = mapCalendarEvent(
    {
      id: result.record.id,
      status: 'confirmed',
      summary: event.summary,
      htmlLink: result.record.url ?? '',
      updated: new Date().toISOString(),
      start: event.start,
      end: event.end,
    },
    { calendarId, accountId: integration.accountId, timeZone: ctx.settings.timezone },
  );
  return 'deleted' in mapped ? null : mapped;
}
