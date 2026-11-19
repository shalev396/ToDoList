import { type RequestHandler } from 'express';

import { ItemQuery, TimeBlock } from '../classes/item/index.js';
import {
  CreateTimeBlockBody,
  EditTimeBlockBody,
  SkipOccurrenceBody,
  optionalTime,
  requiredTime,
} from '../services/timeBlockSchemas.js';
import type { WorkspaceRequest } from '../types/express.js';
import type { TimeBlockResponseData } from '../types/timeBlocks.js';
import { parseOr400, routeParam } from '../utils/validation.js';

/** A block or an area (201; the same idempotency key again: 200 with the one made). */
const create: RequestHandler = async (req, res): Promise<void> => {
  const { layer, startAt, endAt, ...rest } = parseOr400(CreateTimeBlockBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const { block, created } = await TimeBlock.create(caller, {
    ...rest,
    layer: layer ?? 'block',
    startAt: requiredTime(startAt, 'startAt'),
    endAt: requiredTime(endAt, 'endAt'),
  });
  const data: TimeBlockResponseData = await (await ItemQuery.for(caller)).detail(block);
  res.success(data, created ? 201 : 200);
};

/** "This one" (one occurrence's times) or "all" (the series). */
const edit: RequestHandler = async (req, res): Promise<void> => {
  const { scope, originalStart, startAt, endAt, ...series } = parseOr400(
    EditTimeBlockBody,
    req.body,
  );
  const { caller } = req as WorkspaceRequest;
  const block = await TimeBlock.find(caller, routeParam(req, 'id'));
  const edited =
    scope === 'this'
      ? await block.editOccurrence(caller, requiredTime(originalStart, 'originalStart'), {
          startAt: requiredTime(startAt, 'startAt'),
          endAt: requiredTime(endAt, 'endAt'),
        })
      : await block.editSeries(caller, {
          ...series,
          startAt: optionalTime(startAt),
          endAt: optionalTime(endAt),
        });
  const data: TimeBlockResponseData = await (await ItemQuery.for(caller)).detail(edited);
  res.success(data);
};

/** One occurrence left out. */
const skip: RequestHandler = async (req, res): Promise<void> => {
  const { originalStart } = parseOr400(SkipOccurrenceBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const block = await TimeBlock.find(caller, routeParam(req, 'id'));
  const skipped = await block.skipOccurrence(caller, requiredTime(originalStart, 'originalStart'));
  const data: TimeBlockResponseData = await (await ItemQuery.for(caller)).detail(skipped);
  res.success(data);
};

export const TimeBlocksController = { create, edit, skip } as const;
