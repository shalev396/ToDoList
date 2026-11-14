import { type RequestHandler } from 'express';

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
import {
  completeItem,
  createItem,
  deleteItem,
  getFacets,
  getItem,
  ItemMirroredResponse,
  listItems,
  updateItem,
  updateOverlay,
} from '../services/items.js';
import { redactString } from '../services/secretPatterns.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

/** A mirrored item is edited at its source: 409 `{message, openIn}`. */
function withMirrored(handler: RequestHandler): RequestHandler {
  return async (req, res, next): Promise<void> => {
    try {
      await handler(req, res, next);
    } catch (error) {
      if (error instanceof ItemMirroredResponse) {
        // Raw json, not res.error: the body carries `openIn` next to the message.
        res.status(409).json({ message: redactString(error.message), openIn: error.openIn });
        return;
      }
      throw error;
    }
  };
}

function toDate(value: string | null | undefined): Date | null | undefined {
  return value === undefined || value === null ? value : new Date(value);
}

const list: RequestHandler = async (req, res): Promise<void> => {
  const query = parseOr400(ListItemsQuerySchema, req.query);
  const { workspace, user } = req as WorkspaceRequest;
  const data: ListItemsResponseData = await listItems(workspace, user.id, query);
  res.success(data);
};

const get: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, user } = req as WorkspaceRequest;
  const data: GetItemResponseData = await getItem(workspace, user.id, routeParam(req, 'id'));
  res.success(data);
};

const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreateItemBody, req.body);
  const { workspace, user } = req as WorkspaceRequest;
  const { item, created } = await createItem(workspace, user.id, {
    ...body,
    dueAt: toDate(body.dueAt),
  });
  const data: CreateItemResponseData = item;
  res.success(data, created ? 201 : 200);
};

const update: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UpdateItemBody, req.body);
  const { workspace, user } = req as WorkspaceRequest;
  const data: UpdateItemResponseData = await updateItem(workspace, user.id, routeParam(req, 'id'), {
    ...body,
    dueAt: toDate(body.dueAt),
  });
  res.success(data);
};

const remove: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, user } = req as WorkspaceRequest;
  await deleteItem(workspace, user.id, routeParam(req, 'id'));
  res.status(204).end();
};

const overlay: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UpdateOverlayBody, req.body);
  const { workspace, user } = req as WorkspaceRequest;
  const data: UpdateOverlayResponseData = await updateOverlay(
    workspace,
    user.id,
    routeParam(req, 'id'),
    body,
  );
  res.success(data);
};

const complete: RequestHandler = async (req, res): Promise<void> => {
  const { done } = parseOr400(CompleteItemBody, req.body);
  const { workspace, user } = req as WorkspaceRequest;
  const data: CompleteItemResponseData = await completeItem(
    workspace,
    user.id,
    routeParam(req, 'id'),
    done,
  );
  res.success(data);
};

const facets: RequestHandler = async (req, res): Promise<void> => {
  const { connectors } = parseOr400(FacetsQuery, req.query);
  const { workspace, user } = req as WorkspaceRequest;
  const data: FacetsResponseData = await getFacets(
    workspace,
    user.id,
    connectors === undefined ? undefined : connectors.split(',').filter((id) => id !== ''),
  );
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
