import { Router, type ErrorRequestHandler, type RequestHandler } from 'express';

import { McpOAuthController } from '../controllers/index.js';
import { OAuthError } from '../errors/OAuthError.js';
import {
  discoveryLimiter,
  mcpOAuthLimiter,
  mcpTokenLimiter,
  oauthLimiter,
} from '../middlewares/rateLimit.js';

/**
 * MCP sign-in, the agent's side (OAuth 2.1 with PKCE). Public: no Cognito, no `{ data }` envelope;
 * answers are the RFC wire formats. Two routers share the controller:
 * - `mcpOAuthRouter` at /api/mcp/oauth: the endpoints, and discovery under the issuer;
 * - `wellKnownRouter` at /.well-known: the same documents at the root forms RFC 8414 and RFC 9728
 *   derive from the issuer and the resource.
 */

/** Nothing the OAuth endpoints answer may be cached: it holds codes and tokens. */
const noStore: RequestHandler = (_req, res, next): void => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
};

/** An OAuthError as RFC 6749 section 5.2 JSON, with its status. */
const oauthErrors: ErrorRequestHandler = (error: unknown, _req, res, next): void => {
  if (res.headersSent || !(error instanceof OAuthError)) {
    next(error);
    return;
  }
  res.status(error.statusCode).json({ error: error.oauthCode, error_description: error.message });
};

const router = Router();
router.use(noStore);

// ─── Discovery ──────────────────────────────────────────────────────────────

router.get(
  '/.well-known/oauth-authorization-server',
  discoveryLimiter,
  McpOAuthController.authorizationServer,
);
router.get(
  '/.well-known/openid-configuration',
  discoveryLimiter,
  McpOAuthController.authorizationServer,
);
router.get('/resource-metadata', discoveryLimiter, McpOAuthController.protectedResource(false));
// The OpenID discovery form names a key set; no ID tokens are issued, so it is empty.
router.get('/jwks', discoveryLimiter, (_req, res) => {
  res.json({ keys: [] });
});
router.get(
  '/resource-metadata/readonly',
  discoveryLimiter,
  McpOAuthController.protectedResource(true),
);

// ─── Endpoints ──────────────────────────────────────────────────────────────

/** POST /register: JSON in (RFC 7591), 201 with the client. */
router.post('/register', mcpOAuthLimiter, McpOAuthController.register);

/** GET /authorize: 302 to the consent page, or a 400 text page when it can't safely redirect. */
router.get('/authorize', oauthLimiter, McpOAuthController.authorize);

/** POST /token: a form; the code or refresh_token grant. */
router.post('/token', mcpTokenLimiter, McpOAuthController.token);

/** POST /revoke: RFC 7009, 200 even for an unknown token. */
router.post('/revoke', mcpTokenLimiter, McpOAuthController.revoke);

router.use(oauthErrors);

export { router as mcpOAuthRouter };

// ─── /.well-known ───────────────────────────────────────────────────────────

const wellKnown = Router();
wellKnown.use(noStore);
wellKnown.get(
  '/oauth-authorization-server/api/mcp/oauth',
  discoveryLimiter,
  McpOAuthController.authorizationServer,
);
wellKnown.get(
  '/openid-configuration/api/mcp/oauth',
  discoveryLimiter,
  McpOAuthController.authorizationServer,
);
wellKnown.get(
  '/oauth-protected-resource/api/mcp',
  discoveryLimiter,
  McpOAuthController.protectedResource(false),
);
wellKnown.get(
  '/oauth-protected-resource/api/mcp/readonly',
  discoveryLimiter,
  McpOAuthController.protectedResource(true),
);

export { wellKnown as wellKnownRouter };
