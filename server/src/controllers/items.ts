import { type RequestHandler, type Response } from 'express';

import { CalendarEvent, Item, ItemEdit, ItemQuery, Todo } from '../classes/item/index.js';
import { AppError } from '../errors/AppError.js';
import { CreatedNotStoredError } from '../errors/CreatedNotStoredError.js';
import { WrittenNotStoredError } from '../errors/WrittenNotStoredError.js';
import { FieldNotWritableError } from '../errors/FieldNotWritableError.js';
import { MirroredItemError } from '../errors/MirroredItemError.js';
import { ProviderPartialWriteError } from '../errors/ProviderPartialWriteError.js';
import type {
  CompleteItemResponseData,
  CreateItemResponseData,
  FacetsResponseData,
  GetItemResponseData,
  ListItemsResponseData,
  UpdateItemResponseData,
  UpdateOverlayResponseData,
} from '../routes/private/items.js';
import {
  CompleteItemBody,
  CreateItemBody,
  ListItemsQuerySchema,
  UpdateItemBody,
  UpdateOverlayBody,
  FacetsQuery,
} from '../services/itemSchemas.js';
import { redactString } from '../services/secretPatterns.js';
import { optionalTime } from '../services/timeBlockSchemas.js';
import type { WorkspaceRequest } from '../types/express.js';
import type { WriteBackErrorDetails } from '../types/items.js';
import { parseOr400, routeParam } from '../utils/validation.js';

/** A mirrored item is edited at its source: 409 `{message, openIn}`. */
function withMirrored(handler: RequestHandler): RequestHandler {
  return async (req, res, next): Promise<void> => {
    try {
      await handler(req, res, next);
    } catch (error) {
      if (error instanceof MirroredItemError) {
        // Raw json, not res.error: the body carries `openIn` next to the message.
        res.status(409).json({ message: redactString(error.message), openIn: error.openIn });
        return;
      }
      throw error;
    }
  };
}

/**
 * The details a write-back refusal carries, allow-listed (field names and the item's own link,
 * never a value or provider text): `fields` and `openIn` of a field the provider won't take,
 * `written`, `refused`, `uncertain` and `kept` of a write that stopped part-way, and `written` of
 * a change the provider took that could not be stored here. Null for anything else.
 */
function writeBackDetails(error: unknown): WriteBackErrorDetails | null {
  if (error instanceof FieldNotWritableError) {
    return {
      fields: [...error.fields],
      openIn: error.openIn === null ? null : { ...error.openIn },
    };
  }
  if (error instanceof ProviderPartialWriteError) {
    return {
      written: [...error.written],
      refused: [...error.refused],
      uncertain: [...error.uncertain],
      kept: [...error.kept],
    };
  }
  if (error instanceof CreatedNotStoredError || error instanceof WrittenNotStoredError) {
    return { written: [...error.written] };
  }
  return null;
}

/** A write-back refusal: `{message, code, details}` (the envelope's fields, plus `details`). */
function answeredWriteBack(error: unknown, res: Response): boolean {
  const details = writeBackDetails(error);
  if (details === null || !(error instanceof AppError)) return false;
  res.status(error.statusCode).json({
    message: redactString(error.message),
    ...(error.code === undefined ? {} : { code: error.code }),
    details,
  });
  return true;
}

function toDate(value: string | null | undefined): Date | null | undefined {
  return value === undefined || value === null ? value : new Date(value);
}

const list: RequestHandler = async (req, res): Promise<void> => {
  const query = parseOr400(ListItemsQuerySchema, req.query);
  const { caller } = req as WorkspaceRequest;
  const data: ListItemsResponseData = await (await ItemQuery.for(caller)).list(query);
  res.success(data);
};

const get: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const data: GetItemResponseData = await (await ItemQuery.for(caller)).get(routeParam(req, 'id'));
  res.success(data);
};

/**
 * A to-do (201; the same idempotency key again: 200 with the one made). With `recurrence`, a
 * recurring to-do: a recurring event in the workspace's primary calendar, stored at once as its
 * event item (201); no local to-do is made.
 */
const create: RequestHandler = async (req, res): Promise<void> => {
  try {
    await createItem(req, res);
  } catch (error) {
    if (answeredWriteBack(error, res)) return;
    throw error;
  }
};

async function createItem(req: Parameters<RequestHandler>[0], res: Response): Promise<void> {
  const { recurrence, containerId, startAt, endAt, ...body } = parseOr400(CreateItemBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const reads = await ItemQuery.for(caller);
  if (recurrence !== undefined) {
    if (containerId !== undefined && containerId !== null) {
      throw new AppError(400, 'containerId: a recurring to-do lives in the workspace calendar');
    }
    if (startAt !== undefined || endAt !== undefined) {
      throw new AppError(400, 'startAt: a recurring to-do is timed by its due date');
    }
    const { event, created } = await CalendarEvent.createRecurring(caller, {
      ...body,
      dueAt: toDate(body.dueAt),
      recurrence,
    });
    const data: CreateItemResponseData = await reads.detail(event);
    res.success(data, created ? 201 : 200);
    return;
  }
  const { todo, created } = await Todo.create(caller, {
    ...body,
    ...(containerId === undefined ? {} : { containerId }),
    dueAt: toDate(body.dueAt),
    startAt: optionalTime(startAt),
    endAt: optionalTime(endAt),
  });
  const data: CreateItemResponseData = await reads.detail(todo);
  res.success(data, created ? 201 : 200);
}

/**
 * One edit, split server-side for a mirrored item (Item#edit): its provider fields go to the
 * provider (its integration's owner, read & write), the fields its provider lacks are kept as
 * overrides, anything else is 409 `{message, openIn}`. A provider refusal answers with `details`.
 */
const update: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UpdateItemBody, req.body);
  const { caller } = req as WorkspaceRequest;
  try {
    const item = await Item.find(caller, routeParam(req, 'id'));
    const edited = await item.edit(
      caller,
      ItemEdit.of({
        ...body,
        dueAt: toDate(body.dueAt),
        startAt: toDate(body.startAt),
        endAt: toDate(body.endAt),
      }),
    );
    const data: UpdateItemResponseData = await (await ItemQuery.for(caller)).detail(edited);
    res.success(data);
  } catch (error) {
    if (answeredWriteBack(error, res)) return;
    throw error;
  }
};

/**
 * Local to-dos, time blocks and areas (a mirrored item is deleted at its source: 409 with
 * `openIn`; a travel leg is skipped, never deleted: 409 `not_deletable`).
 */
const remove: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const item = await Item.find(caller, routeParam(req, 'id'));
  await item.deletable().delete(caller);
  res.status(204).end();
};

const overlay: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UpdateOverlayBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const item = await Item.find(caller, routeParam(req, 'id'));
  const updated = await item.setOverlay(caller, body);
  const data: UpdateOverlayResponseData = await (await ItemQuery.for(caller)).detail(updated);
  res.success(data);
};

/**
 * Local to-dos only (a mirrored item is completed at its source: 409 with `openIn`; a time block,
 * an area or a travel leg has no status: 409 `not_completable`).
 */
const complete: RequestHandler = async (req, res): Promise<void> => {
  const { done } = parseOr400(CompleteItemBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const item = await Item.find(caller, routeParam(req, 'id'));
  const updated = await item.completable().complete(caller, done);
  const data: CompleteItemResponseData = await (await ItemQuery.for(caller)).detail(updated);
  res.success(data);
};

const facets: RequestHandler = async (req, res): Promise<void> => {
  const { connectors } = parseOr400(FacetsQuery, req.query);
  const { caller } = req as WorkspaceRequest;
  const data: FacetsResponseData = await (
    await ItemQuery.for(caller)
  ).facets(connectors === undefined ? undefined : connectors.split(',').filter((id) => id !== ''));
  res.success(data);
};

export const ItemsController = {
  list,
  get,
  create,
  update: withMirrored(update),
  remove: withMirrored(remove),
  overlay,
  complete: withMirrored(complete),
  facets,
} as const;
