import { z } from 'zod';

import { AGENT_SCOPES } from '../types/domain.js';

export const CreateAgentKeyBody = z.strictObject({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(AGENT_SCOPES)).min(1).max(AGENT_SCOPES.length),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
