import { type RequestHandler } from 'express';
import { z } from 'zod';

import type { ConsumeConnectLinkResponseData } from '../routes/private/connectLinks.js';
import { consumeConnectLink } from '../services/connectLinks.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400 } from '../utils/validation.js';

/** The link's random id, as the page read it from `?link=`. */
const ConsumeConnectLinkBody = z.strictObject({ link: z.string().min(16).max(128) });

const consume: RequestHandler = async (req, res): Promise<void> => {
  const { link } = parseOr400(ConsumeConnectLinkBody, req.body);
  const { workspace, user } = req as WorkspaceRequest;
  const { provider, expiresAt } = await consumeConnectLink(workspace, user.id, link);
  const data: ConsumeConnectLinkResponseData = { provider, expiresAt: expiresAt.toISOString() };
  res.success(data);
};

export const ConnectLinksController = { consume } as const;
