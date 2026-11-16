/**
 * A local to-do: an item TodoList owns (source `local`), so every field of it is edited here, by
 * an editor who sees it (ItemPolicy: shared to-dos, and their own private ones). It can be
 * completed, deleted (its events on the workspace calendar go at once) and copied into one of its
 * owner's providers (`copyTo`, polymorphic over the target: a TaskProvider creates a task, a
 * CalendarProvider inserts an event, both through the integration's write gate).
 */
import type { Caller } from '../base/Caller.js';
import { CalendarLinks } from '../calendar/CalendarLinks.js';
import { ItemPolicy } from '../policies/ItemPolicy.js';
import { Topic } from '../workspace/Topic.js';
import { AppError } from '../../errors/AppError.js';
import { MirroredItemError } from '../../errors/MirroredItemError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import type { ItemData, LocalItemPatch } from '../../models/definitions/Item.js';
import { MirroredItemError as StoredMirroredItemError } from '../../models/errors.js';
import { getItemRepository } from '../../models/index.js';
import type { CreateCopyOutcome, CreateCopyRequestBody } from '../../types/providerCreate.js';
import { Container } from './Container.js';
import type { Completable, Copyable, Deletable, Editable, HasDueDate } from './contracts.js';
import { Item } from './Item.js';
import type { ItemEdit, ProviderHalf } from './ItemEdit.js';
import { ItemEditing } from './ItemEditing.js';
import { TimeRange } from './TimeRange.js';
import { TodoCopy } from './TodoCopy.js';

/** A new to-do, as callers give it. */
export interface NewTodo {
  title: string;
  note?: string | undefined;
  dueAt?: Date | null | undefined;
  allDay?: boolean | undefined;
  /** A topic of the workspace; null = Unsorted. Default: the workspace's `personal` topic, if any. */
  topicId?: string | null | undefined;
  containerId?: string | null | undefined;
  priority?: number | null | undefined;
  idempotencyKey?: string | undefined;
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

function closedAtFor(done: boolean, now: Date): Date | null {
  return done ? now : null;
}

export class Todo
  extends Item
  implements Editable<Todo>, Completable<Todo>, Deletable, HasDueDate, Copyable
{
  static {
    Item.register('todo', (data) => new Todo(data));
  }

  private constructor(data: ItemData) {
    super(data);
  }

  /**
   * Editors: a new to-do of the caller's. `topicId` defaults to the workspace's `personal` topic
   * (an unknown topic or a container the caller can't see is 400). `created` is false when the
   * caller already made one with this idempotency key (the unique partial index on (workspace,
   * owner, key) makes that race-free).
   */
  static async create(caller: Caller, input: NewTodo): Promise<{ todo: Todo; created: boolean }> {
    caller.require('editor');
    if (input.containerId !== undefined && input.containerId !== null) {
      await Container.assertVisible(caller, await ItemPolicy.for(caller), input.containerId);
    }
    const workspaceId = caller.workspaceId;
    if (input.topicId !== undefined && input.topicId !== null) {
      await Topic.assertOf(workspaceId, input.topicId);
    }
    const topicId =
      input.topicId === undefined
        ? ((await Topic.bySlug(workspaceId, 'personal'))?.id ?? null)
        : input.topicId;
    const items = await getItemRepository();
    try {
      const stored = await items.createLocal(workspaceId, {
        ownerUserId: caller.userId,
        title: input.title,
        topicId,
        ...(input.note === undefined ? {} : { bodyPreview: input.note }),
        ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
        ...(input.allDay === undefined ? {} : { allDay: input.allDay }),
        ...(input.containerId === undefined ? {} : { containerId: input.containerId }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.idempotencyKey === undefined
          ? {}
          : { props: { idempotencyKey: input.idempotencyKey } }),
      });
      return { todo: new Todo(stored), created: true };
    } catch (error) {
      if (input.idempotencyKey === undefined || !isDuplicateKey(error)) throw error;
      const [existing] = await items.aggregate(workspaceId, [
        { $match: { ownerUserId: caller.userId, 'props.idempotencyKey': input.idempotencyKey } },
        { $limit: 1 },
      ]);
      if (existing === undefined) throw error;
      const found = Item.fromDoc(existing);
      if (!(found instanceof Todo)) throw error;
      return { todo: found, created: false };
    }
  }

  /**
   * H5: the caller's own to-do `id`, created in one of their providers too (TodoCopy.start: an
   * editor, a well-formed request id, then the to-do, each checked once).
   */
  static copyOwn(
    caller: Caller,
    id: string,
    request: CreateCopyRequestBody,
    now: Date = new Date(),
  ): Promise<CreateCopyOutcome> {
    return TodoCopy.start(caller, request, (who) => Todo.findOwn(who, id), now);
  }

  /**
   * Whether the caller made a to-do with this idempotency key, live or deleted (the demo data
   * leaves one its owner deleted as it is).
   */
  static async existsWithKey(caller: Caller, idempotencyKey: string): Promise<boolean> {
    const [existing] = await (
      await getItemRepository()
    ).aggregate(caller.workspaceId, [
      { $match: { ownerUserId: caller.userId, 'props.idempotencyKey': idempotencyKey } },
      { $limit: 1 },
    ]);
    return existing !== undefined;
  }

  /** How many of the caller's to-dos with these idempotency keys are live. */
  static async countLiveWithKeys(caller: Caller, keys: readonly string[]): Promise<number> {
    return Item.countLive(caller.workspaceId, {
      ownerUserId: caller.userId,
      'props.idempotencyKey': { $in: [...keys] },
    });
  }

  /** The caller's own live to-do (anyone else's, or a mirrored item: 404). */
  static async findOwn(caller: Caller, id: string): Promise<Todo> {
    const stored = await (await getItemRepository()).findById(caller.workspaceId, id);
    if (stored?.source.provider !== 'local' || stored.ownerUserId !== caller.userId) {
      throw new NotFoundError();
    }
    return new Todo(stored);
  }

  readonly isLocal = true;

  editing(): Promise<ItemEditing> {
    return Promise.resolve(ItemEditing.local());
  }

  protected get defaultEditing(): ItemEditing {
    return ItemEditing.local();
  }

  /** Its notes as the provider copy takes them (the preview text). */
  get note(): string | null {
    return this.data.bodyPreview;
  }

  /** Editors who see it change its own fields (a topic or container must be one they can use). */
  async update(caller: Caller, edit: ItemEdit): Promise<Todo> {
    const policy = await this.#authorize(caller);
    const container = edit.get('containerId');
    if (container !== undefined && container !== null) {
      await Container.assertVisible(caller, policy, container);
    }
    const topic = edit.get('topicId');
    if (topic !== undefined && topic !== null) await Topic.assertOf(this.workspaceId, topic);
    this.#assertTimeRange(edit);
    return this.#store(edit.localPatch());
  }

  edit(caller: Caller, edit: ItemEdit): Promise<Todo> {
    return this.update(caller, edit);
  }

  /** A to-do has no provider: nothing of an edit goes anywhere but here. */
  providerChanges(): Promise<ProviderHalf> {
    return Promise.resolve({});
  }

  /** Done, or open again. */
  async complete(caller: Caller, done: boolean, now: Date = new Date()): Promise<Todo> {
    await this.#authorize(caller);
    return this.#store({ status: done ? 'done' : 'open', closedAt: closedAtFor(done, now) });
  }

  /**
   * A soft delete (the purge removes it 30 days later); its provider copies become ordinary
   * mirrored items, and its events on the workspace calendar go now, not at the next push.
   */
  async delete(caller: Caller): Promise<void> {
    const policy = await ItemPolicy.for(caller);
    caller.authorize(policy, 'manage', this.facts);
    if (!(await (await getItemRepository()).softDelete(this.workspaceId, this.id))) {
      throw new AppError(404, 'Not found');
    }
    await CalendarLinks.in(this.workspaceId).onItemDeleted(this.id, caller);
  }

  /** H5: created in one of the caller's own providers too (TodoCopy). */
  copyTo(
    caller: Caller,
    request: CreateCopyRequestBody,
    now: Date = new Date(),
  ): Promise<CreateCopyOutcome> {
    return new TodoCopy(caller, this, request, now).run();
  }

  /** Its start and end, once edited, in order (400 naming `endAt` otherwise; TimeRange's rule). */
  #assertTimeRange(edit: ItemEdit): void {
    if (!edit.has('startAt') && !edit.has('endAt') && !edit.has('allDay')) return;
    const start = edit.has('startAt') ? (edit.get('startAt') ?? null) : this.data.startAt;
    const end = edit.has('endAt') ? (edit.get('endAt') ?? null) : this.data.endAt;
    if (start === null || end === null) return;
    TimeRange.of(start, end, edit.get('allDay') ?? this.data.allDay);
  }

  /** The policy, once it let the caller edit this to-do (403, 404, or the mirrored 409). */
  async #authorize(caller: Caller): Promise<ItemPolicy> {
    this.assertIn(caller);
    const policy = await ItemPolicy.for(caller);
    caller.authorize(policy, 'edit', this.facts);
    return policy;
  }

  async #store(patch: LocalItemPatch): Promise<Todo> {
    try {
      const updated = await (
        await getItemRepository()
      ).updateLocal(this.workspaceId, this.id, patch);
      if (updated === null) throw new AppError(404, 'Not found');
      return new Todo(updated);
    } catch (error) {
      if (error instanceof StoredMirroredItemError) {
        throw new MirroredItemError(error.provider, error.url);
      }
      throw error;
    }
  }
}
