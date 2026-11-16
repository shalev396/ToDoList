import { type RequestHandler } from 'express';
import { z } from 'zod';

import type { ConsumeConnectLinkResponseData } from '../routes/private/connectLinks.js';
import { ConnectLink } from '../classes/ConnectLink.js';
import type { WorkspaceRequest } from '../types/express.js';
import { parseOr400 } from '../utils/validation.js';

/** The link's random id, as the page read it from `?link=`. */
const ConsumeConnectLinkBody = z.strictObject({ link: z.string().min(16).max(128) });

const consume: RequestHandler = async (req, res): Promise<void> => {
  const { link } = parseOr400(ConsumeConnectLinkBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const { provider, expiresAt } = await ConnectLink.consume(caller, link, new Date());
  const data: ConsumeConnectLinkResponseData = { provider, expiresAt: expiresAt.toISOString() };
  res.success(data);
};

export const ConnectLinksController = { consume } as const;
