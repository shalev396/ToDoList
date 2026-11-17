import { z } from 'zod';

import { OAuthError } from '../errors/OAuthError.js';
import { AGENT_SCOPES } from '../types/domain.js';

/**
 * The token endpoint's form. Every field is optional text here: which ones a grant needs is the
 * grant's business (McpAuthorization.exchange, AgentKey.refresh). A field that is not plain text
 * (a repeated form key) is an invalid request.
 */
const text = z.string().max(4096).optional();

export const TokenForm = z.object({
  grant_type: text,
  code: text,
  code_verifier: text,
  client_id: text,
  redirect_uri: text,
  resource: text,
  refresh_token: text,
});

export const RevokeForm = z.object({
  token: z.string().min(1).max(4096),
  client_id: z.string().min(1).max(2048),
});

/** The consent page's yes. McpAuthorization.approve checks the values against the member's role. */
export const ApproveConsentBody = z.strictObject({
  workspaceId: z.string().min(1).max(64),
  scopes: z.array(z.enum(AGENT_SCOPES)).max(AGENT_SCOPES.length),
  name: z.string().max(200),
});

/** Parses an OAuth request body, or throws RFC 6749's `invalid_request`. */
export function parseOAuth<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new OAuthError('invalid_request', 'The request is missing a parameter or is malformed');
}
