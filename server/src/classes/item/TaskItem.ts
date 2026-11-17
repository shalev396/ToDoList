/**
 * A task mirrored from a to-do integration (Jira, ClickUp, Linear, GitHub; also an assignment,
 * deadline or message from any provider): a MirroredItem with a due date. Its provider half goes
 * to TaskProvider#updateTask, which writes the fields its provider takes for its kind (Jira title,
 * status, due date, priority; ClickUp also the start; Linear like Jira; GitHub's issue title and
 * status) and refuses everything else there (422 `field_not_writable`).
 */
import type { Caller } from '../base/Caller.js';
import { isTaskProvider, type Integration } from '../integration/index.js';
import type { TaskPatch } from '../integration/TaskEdit.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import type { ItemData } from '../../models/definitions/Item.js';
import type { HasDueDate } from './contracts.js';
import { Item } from './Item.js';
import type { ProviderHalf } from './ItemEdit.js';
import { MirroredItem } from './MirroredItem.js';

export class TaskItem extends MirroredItem implements HasDueDate {
  static {
    Item.register('task', (data) => new TaskItem(data));
  }

  protected constructor(data: ItemData) {
    super(data);
  }

  protected async writeBack(
    caller: Caller,
    integration: Integration,
    half: ProviderHalf,
  ): Promise<void> {
    if (!isTaskProvider(integration)) throw new NotFoundError();
    const patch: TaskPatch = {
      ...(half.title === undefined ? {} : { title: half.title }),
      ...(half.status === undefined ? {} : { status: half.status }),
      ...(half.dueAt === undefined ? {} : { dueAt: half.dueAt }),
      ...(half.allDay === undefined || half.dueAt === undefined || half.dueAt === null
        ? {}
        : { allDay: half.allDay }),
      ...(half.startAt === undefined ? {} : { startAt: half.startAt }),
      ...(half.priority === undefined ? {} : { priority: half.priority }),
    };
    await integration.updateTask(caller, { id: this.id }, patch);
  }
}
