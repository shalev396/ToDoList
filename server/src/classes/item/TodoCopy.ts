/**
 * One attempt to create a local to-do in one of its owner's providers too (H5, D19: "Also create
 * in"), as a method object: Todo#copyTo runs one. The one place TodoList writes a NEW item to a
 * provider, only after an explicit user action.
 *
 * Gates, in order: an editor or above; the to-do is the caller's own (Todo.findOwn); the
 * integration is the caller's own (anyone else's is a 404); it can create there; a repeat of a
 * request answers with what it did, and a to-do with a copy already pending, created or unknown
 * at this integration answers that copy (unless `retryAnyway`); writes are on for it and it is
 * read & write (the integration's write gate, 409); a calendar event needs a due date; the hourly
 * limit is reserved atomically BEFORE the provider is called (CreateQuota); the same `requestId`
 * never creates twice. Then the target sends it (CopyTarget, polymorphic: a TaskProvider creates a
 * task, a CalendarProvider inserts an event), through the integration's write session. A request
 * that was sent and got no answer is `unknown` and is never retried.
 *
 * Right after the provider answers, the create is audited and the copy's status recorded (no title
 * or token in the entry). Reading the item back and storing it as a mirrored copy come after, best
 * effort and under a short budget: they never change what is reported.
 */
import type { Caller } from '../base/Caller.js';
import {
  Integration,
  isCalendarProvider,
  isTaskProvider,
  type CalendarProvider,
  type CreateFields,
  type PlainEventBody,
  type TaskProvider,
  type WriteResult,
} from '../integration/index.js';
import { definitionOf, strategyOf } from '../integration/definitions/index.js';
import { AppError } from '../../errors/AppError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { ItemCopy } from '../../models/definitions/Item.js';
import { getItemRepository } from '../../models/index.js';
import { logger } from '../../services/logger.js';
import { checkedId } from '../integration/providerIds.js';
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
  type CreateTarget,
} from '../../types/providerCreate.js';
import { isScheduledKind } from '../../types/scheduled.js';
import { Copies } from './Copies.js';
import { CreateQuota } from './CreateQuota.js';
import { MirroredItem } from './MirroredItem.js';
import {
  auditProviderCreate,
  safeCopyUrl,
  within,
  type CreateAuditResult,
} from './providerCreates.js';
import type { Todo } from './Todo.js';
import { EVENT_NOTE_MAX, eventIdFor, todoEvent } from './todoEvent.js';

/** The mirror may take this long; then the create is reported as is. */
const READ_BACK_BUDGET_MS = 5_000;
const GITHUB_INSTALLATIONS_URL = 'https://github.com/settings/installations';

export const isCreatableProvider = (value: string): value is CreatableProvider =>
  (CREATABLE_PROVIDERS as readonly string[]).includes(value);

/**
 * The failure a refusal is, in the words the UI maps. A 403 means what the provider's definition
 * says for an OAuth grant (GitHub: a permission the App lacks); a key or token that is refused
 * cannot create.
 */
export function failureFor(
  integration: Pick<IntegrationData, 'provider' | 'authMethod'>,
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
      if (strategyOf(integration)?.kind !== 'oauth') return 'token_cannot_create';
      return definitionOf(integration.provider)?.create?.forbiddenWithOAuth ?? 'rejected';
    default:
      return 'rejected';
  }
}

/** The outcome a stored copy stands for (a repeat of a request answers with it). */
function outcomeOf(copy: ItemCopy): CreateCopyOutcome {
  const view = Copies.viewOf(copy);
  if (copy.status === 'created') return { status: 'created', copy: view };
  if (copy.status === 'failed') return { status: 'failed', reason: 'rejected', copy: view };
  return { status: 'unknown', copy: { ...view, status: 'unknown' } };
}

/** What a target sends, and how it reports back. */
interface CopySend {
  readonly caller: Caller;
  readonly todo: Todo;
  readonly requestId: string;
  readonly fields: CreateFields;
  /** Records the provider's answer at once (the audit entry, the copy's status). */
  settle(result: WriteResult): Promise<void>;
}

/** What a target sent: the answer (null: nothing came back) and the created item, mapped. */
interface CopySent {
  result: WriteResult | null;
  mapped: MappedItem | null;
}

/**
 * Where a copy goes (strategy, polymorphic over the integration's contract): a task of a
 * TaskProvider or an event of a CalendarProvider. `for` picks it; each validates what it needs and
 * sends through its integration's write session.
 */
abstract class CopyTarget {
  /** The target for this integration (400 when the target names another kind). */
  static for(integration: Integration, target: CreateTarget): CopyTarget {
    if (isCalendarProvider(integration)) {
      if (target.provider !== 'google_calendar') {
        throw new AppError(400, 'target: nothing is created this way');
      }
      return new EventCopyTarget(integration, target.calendarId);
    }
    if (isTaskProvider(integration)) return new TaskCopyTarget(integration, target);
    throw new AppError(400, 'target: nothing is created this way');
  }

  /** What the to-do needs before anything is reserved (400 otherwise). */
  abstract check(todo: Todo): void;

  /** Sends the copy, handing the answer to `send.settle` at once. */
  abstract send(send: CopySend): Promise<CopySent>;
}

/** A task created by a to-do integration (TaskProvider#createTask). */
class TaskCopyTarget extends CopyTarget {
  readonly #integration: Integration & TaskProvider;
  readonly #target: CreateTarget;

  constructor(integration: Integration & TaskProvider, target: CreateTarget) {
    super();
    this.#integration = integration;
    this.#target = target;
  }

  check(): void {
    // A task needs nothing beyond what the funnel picked.
  }

  async send(send: CopySend): Promise<CopySent> {
    const state: CopySent = { result: null, mapped: null };
    const created = await this.#integration.createTask(send.caller, {
      target: this.#target,
      fields: send.fields,
      settle: async (result) => {
        state.result = result;
        await send.settle(result);
      },
    });
    return { result: state.result, mapped: created.mapped };
  }
}

/** An event inserted in the calendar the user picked (CalendarProvider#insertEvent). */
class EventCopyTarget extends CopyTarget {
  readonly #integration: Integration & CalendarProvider;
  readonly #calendarId: unknown;

  constructor(integration: Integration & CalendarProvider, calendarId: unknown) {
    super();
    this.#integration = integration;
    this.#calendarId = calendarId;
  }

  /** (Whether this connection can create events at all is TodoCopy's check, before this.) */
  check(todo: Todo): void {
    if (todo.dueAt === null) {
      throw new AppError(400, 'A calendar event needs a due date', { code: 'needs_due_date' });
    }
  }

  async send(send: CopySend): Promise<CopySent> {
    const calendarId = checkedId('calendarId', this.#calendarId, 'calendarId');
    const event = todoEvent(
      {
        title: send.fields.title,
        note: send.fields.description,
        dueAt: send.todo.dueAt,
        allDay: send.todo.allDay,
      },
      send.fields.timeZone,
      eventIdFor(send.requestId),
    );
    if (event === null) throw new AppError(400, 'A calendar event needs a title and a due date');
    const result = await this.#integration.insertEvent(send.caller, calendarId, event);
    await send.settle(result);
    return {
      result,
      mapped:
        result.kind === 'created'
          ? this.#readBack(send, calendarId, event, result.record.id, result.record.url)
          : null,
    };
  }

  /** The event as the calendar sync maps it, stored at once. */
  #readBack(
    send: CopySend,
    calendarId: string,
    event: PlainEventBody,
    id: string,
    url: string | null,
  ): MappedItem | null {
    const mapped = mapCalendarEvent(
      {
        id,
        status: 'confirmed',
        summary: event.summary,
        htmlLink: url ?? '',
        updated: new Date().toISOString(),
        start: event.start,
        end: event.end,
      },
      {
        calendarId,
        accountId: this.#integration.accountId,
        timeZone: send.fields.timeZone,
      },
    );
    return 'deleted' in mapped ? null : mapped;
  }
}

export class TodoCopy {
  readonly #caller: Caller;
  readonly #todo: Todo;
  readonly #body: CreateCopyRequestBody;
  readonly #now: Date;

  constructor(caller: Caller, todo: Todo, body: CreateCopyRequestBody, now: Date = new Date()) {
    this.#caller = caller;
    this.#todo = todo;
    this.#body = body;
    this.#now = now;
  }

  /**
   * A copy of the to-do `find` loads (the caller's own), checked in the order the API answers: an
   * editor (403), a well-formed request id (400), then the to-do (404). Each check runs once.
   */
  static async start(
    caller: Caller,
    body: CreateCopyRequestBody,
    find: (caller: Caller) => Promise<Todo>,
    now: Date = new Date(),
  ): Promise<CreateCopyOutcome> {
    const requestId = TodoCopy.#checked(caller, body);
    return new TodoCopy(caller, await find(caller), body, now).#create(requestId);
  }

  /** The request's own checks: an editor, a well-formed request id (the id, once checked). */
  static #checked(caller: Caller, body: CreateCopyRequestBody): string {
    caller.require('editor');
    return checkedId('requestId', body.requestId, 'requestId');
  }

  /**
   * Creates the copy in one provider. 409 `provider_writes_off` when creating is off for it here,
   * 409 `integration_read_only` while it is read-only (nothing is reserved or sent), 429
   * `create_rate_limited` past the hourly limit, 400 for a bad target, `needs_due_date` for a
   * calendar event without a due date. Everything the provider decides comes back as an outcome.
   */
  async run(): Promise<CreateCopyOutcome> {
    return this.#create(TodoCopy.#checked(this.#caller, this.#body));
  }

  async #create(requestId: string): Promise<CreateCopyOutcome> {
    const caller = this.#caller;
    const todo = this.#todo;
    const body = this.#body;
    if (todo.ownerUserId !== caller.userId || todo.workspaceId !== caller.workspaceId) {
      throw new AppError(404, 'Not found');
    }
    const integration = await Integration.findOwn(caller, body.integrationId);
    const data = integration.toJSON();
    if (!isCreatableProvider(integration.provider)) {
      throw new AppError(409, 'Nothing can be created in this provider');
    }
    if (integration.provider !== body.target.provider) {
      throw new AppError(400, 'target: not a target of this integration');
    }
    const target = CopyTarget.for(integration, body.target);
    if (isCalendarProvider(integration) && !integration.canCreate) {
      throw new AppError(409, 'Only Google Calendar connected with Google can create events');
    }

    // A repeat of a request answers with what it did: it never creates twice.
    const copies = todo.copies;
    const known = copies.byRequest(requestId);
    if (known !== undefined) return outcomeOf(known);
    // Another request id for a to-do that already has a copy here that may exist: the same answer,
    // unless the user said "retry anyway".
    const active = copies.activeAt(integration.id);
    if (active !== undefined && body.retryAnyway !== true) return outcomeOf(active);

    // The write gate's checks, before anything is reserved: writes on here, and read & write.
    integration.assertWritable(caller);
    const fields: CreateFields = {
      title: todo.title,
      description: todo.note === null ? null : todo.note.slice(0, EVENT_NOTE_MAX),
      dueAt: todo.dueAt,
      allDay: todo.allDay,
      priority: todo.priority,
      timeZone: caller.settings.timezone,
    };
    target.check(todo);

    // Reserve the hourly budget before anything is sent; give it back only for a definite "no".
    const quota = CreateQuota.forHour(caller.userId, integration.provider, this.#now);
    await quota.reserveOrRefuse();
    return this.#attempt(integration, data, target, requestId, fields, quota);
  }

  async #attempt(
    integration: Integration,
    data: IntegrationData,
    target: CopyTarget,
    requestId: string,
    fields: CreateFields,
    quota: CreateQuota,
  ): Promise<CreateCopyOutcome> {
    const caller = this.#caller;
    const todo = this.#todo;
    const body = this.#body;
    const workspaceId = caller.workspaceId;
    const items = await getItemRepository();
    // A new attempt replaces this integration's earlier failed one.
    try {
      for (const copy of todo.copies.failedAt(integration.id)) {
        await items.removeCopy(workspaceId, todo.id, copy.requestId);
      }
    } catch (error) {
      await quota.release();
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
      at: this.#now,
    };
    let claimed: boolean;
    try {
      // Atomic per to-do and integration: another request that got here first wins.
      claimed = await items.addCopy(workspaceId, todo.id, pending, {
        allowActive: body.retryAnyway === true,
      });
    } catch (error) {
      await quota.release();
      throw error;
    }
    if (!claimed) {
      await quota.release();
      const again = await items.findById(workspaceId, todo.id);
      if (
        again?.source.provider !== 'local' ||
        again.ownerUserId !== caller.userId ||
        isScheduledKind(again.kind)
      ) {
        throw new AppError(404, 'Not found');
      }
      const copies = Copies.of(again.copies);
      const existing = copies.byRequest(requestId) ?? copies.activeAt(integration.id);
      if (existing !== undefined) return outcomeOf(existing);
      throw new AppError(404, 'Not found');
    }
    const finish = async (
      patch: Partial<Pick<ItemCopy, 'externalId' | 'key' | 'url' | 'status'>>,
    ): Promise<ItemCopy> => {
      try {
        const updated = await items.updateCopy(workspaceId, todo.id, requestId, patch);
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
    const fail = async (
      reason: CreateFailure,
      audit: CreateAuditResult,
    ): Promise<CreateCopyOutcome> => {
      await quota.release();
      await auditProviderCreate(caller, data, audit, null);
      return {
        status: 'failed',
        reason,
        copy: Copies.viewOf(await finish({ status: 'failed' })),
      };
    };

    let needsScope: boolean;
    try {
      needsScope = await integration.needsCreateConsent();
    } catch (error) {
      await quota.release();
      await items.removeCopy(workspaceId, todo.id, requestId).catch(() => undefined);
      throw error;
    }
    if (needsScope) {
      await quota.release();
      const copy = await finish({ status: 'failed' });
      return {
        status: 'needs_permission',
        kind: 'oauth_scope',
        settingsUrl: null,
        copy: Copies.viewOf(copy),
      };
    }

    /** Records what the provider answered, at once: the audit entry and the copy's status. */
    const settle = async (result: WriteResult): Promise<void> => {
      if (result.kind === 'created') {
        await auditProviderCreate(caller, data, 'created', result.record);
        await finish({
          status: 'created',
          externalId: result.record.id,
          key: result.record.key,
          url: safeCopyUrl(data, result.record.url),
        });
      } else if (result.kind === 'unknown') {
        await auditProviderCreate(caller, data, 'unknown', null);
        await finish({ status: 'unknown' });
      } else {
        await quota.release();
        await auditProviderCreate(caller, data, 'refused', null);
        await finish({ status: 'failed' });
      }
    };

    let sent: CopySent = { result: null, mapped: null };
    const state: { answered: WriteResult | null } = { answered: null };
    try {
      sent = await target.send({
        caller,
        todo,
        requestId,
        fields,
        settle: async (result) => {
          state.answered = result;
          await settle(result);
        },
      });
    } catch (error) {
      if (state.answered !== null) {
        // After the provider answered: nothing here changes what happened.
        logger.warn('A created item could not be read back', {
          integrationId: integration.id,
          errorName: error instanceof Error ? error.name : typeof error,
        });
        sent = { result: state.answered, mapped: null };
      } else if (error instanceof AppError) {
        await quota.release();
        await items.removeCopy(workspaceId, todo.id, requestId);
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

    const { result, mapped } = sent;
    if (result === null) return fail('unreachable', 'not_sent');
    if (result.kind === 'unknown') {
      return { status: 'unknown', copy: Copies.viewOf({ ...pending, status: 'unknown' }) };
    }
    if (result.kind === 'refused') {
      const failure = failureFor(data, result.reason);
      const copy = Copies.viewOf({ ...pending, status: 'failed' });
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
          : await within(MirroredItem.store(data, mapped), READ_BACK_BUDGET_MS);
      if (stored !== null) {
        // The to-do's sharing is read now: it may have changed during the create.
        const fresh = await items.findById(workspaceId, todo.id);
        if (fresh !== null) await stored.markAsCopyOf(fresh);
        externalId = stored.externalId;
        await finish({ externalId });
      }
    } catch (error) {
      logger.warn('A created item could not be stored at once', {
        integrationId: integration.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
    const view: ItemCopyView = Copies.viewOf({
      ...pending,
      status: 'created',
      externalId,
      key: record.key,
      url: safeCopyUrl(data, record.url),
    });
    return { status: 'created', copy: view };
  }
}
