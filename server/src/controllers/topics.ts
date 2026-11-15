import { type RequestHandler } from 'express';

import { Topic } from '../classes/workspace/index.js';
import type {
  CreateTopicResponseData,
  DeleteTopicResponseData,
  ListTopicsResponseData,
  TopicView,
  UpdateTopicResponseData,
} from '../routes/private/topics.js';
import { CreateTopicBody, UpdateTopicBody } from '../services/topicSchemas.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400, routeParam } from '../utils/validation.js';

/** Field by field, so nothing added to TopicData later reaches the API by accident. */
export function toTopicView(topic: Topic): TopicView {
  return {
    id: topic.id,
    name: topic.name,
    slug: topic.slug,
    icon: topic.icon,
    colour: topic.colour,
    order: topic.order,
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt,
  };
}

const list: RequestHandler = async (req, res): Promise<void> => {
  const { workspace } = req as WorkspaceRequest;
  const data: ListTopicsResponseData = (await Topic.list(workspace.id)).map(toTopicView);
  res.success(data);
};

const create: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreateTopicBody, req.body);
  const request = req as WorkspaceRequest;
  const { topic, dashboardId } = await Topic.createPage(request.caller, {
    ...body,
    language: body.language ?? 'en',
  });
  const data: CreateTopicResponseData = { topic: toTopicView(topic), dashboardId };
  res.success(data, 201);
};

const update: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UpdateTopicBody, req.body);
  const request = req as WorkspaceRequest;
  const updated = await Topic.update(request.caller, routeParam(req, 'tid'), body);
  const data: UpdateTopicResponseData = toTopicView(updated);
  res.success(data);
};

const remove: RequestHandler = async (req, res): Promise<void> => {
  const request = req as WorkspaceRequest;
  const data: DeleteTopicResponseData = await Topic.delete(request.caller, routeParam(req, 'tid'));
  res.success(data);
};

export const TopicsController = { list, create, update, remove };
