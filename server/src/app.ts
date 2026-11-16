import express, { type Express, type RequestHandler } from 'express';
import {
  responseFormatter,
  errorHandler,
  notFound,
  verifyCognitoToken,
  privateLimiter,
  privateUserLimiter,
  loadCognitoUser,
  requestMemo,
} from './middlewares/index.js';
import { publicRouter, privateRouter } from './routes/index.js';
import { mcpOAuthRouter, wellKnownRouter } from './routes/mcpOAuth.js';
import { mcpBodyErrors, mcpRouter } from './mcp/index.js';
import { installConsoleRedaction } from './services/logger.js';

/** Express 5 leaves `req.body` undefined when a request has no body; handlers can rely on `{}`. */
const defaultBody: RequestHandler = (req, _res, next) => {
  req.body ??= {};
  next();
};

/**
 * JSON and form parsers with the default size limit, mounted per prefix rather than globally so a
 * handler that needs the raw body (a webhook, say) can be mounted ahead of them. Files never come
 * through the API: browsers upload straight to S3 (POST /api/private/uploads/presign).
 *
 * Passed to app.use as one array argument (Express flattens it), never spread: code scanning can't
 * place the arguments after a spread, so the router behind one would lose the limiter in front.
 */
const parseBody: RequestHandler[] = [
  express.json(),
  express.urlencoded({ extended: true }),
  defaultBody,
];

/**
 * The whole API as one Express app — served by the single Lambda (lambda.ts) and by the
 * local dev server (local.ts), which runs it against a deployed stage.
 *
 * - /api/public  → no auth (Cognito sign-up/login flows; rate-limited in routes/public/index.ts)
 * - /api/private → JWT verified in-app (middlewares/expressAuth.ts; API Gateway also runs a JWT
 *   authorizer). Order: privateLimiter (300 per token) → verifyCognitoToken → privateUserLimiter
 *   (200 per verified user) → loadCognitoUser
 *
 * Stage maintenance (schema sync, test reset) is not HTTP: it runs as a direct Lambda invoke, see
 * lambda.ts.
 */
export function createApp(): Express {
  // Every console.* call (ours, Express's, the SDKs') is redacted before it reaches the logs.
  installConsoleRedaction();

  const app = express();

  // CloudFront → API Gateway → Lambda. Measured on a deployed stage: req.ip is the viewer's address
  // (API Gateway's sourceIp), a spoofed X-Forwarded-For entry is ignored, and CloudFront's edge
  // address is not used, so the rate limits are per viewer. Trusting one hop also stops
  // express-rate-limit's ERR_ERL_UNEXPECTED_X_FORWARDED_FOR warning.
  app.set('trust proxy', 1);

  // Each request gets its own memo (services/requestMemo.ts), never shared with another.
  app.use(requestMemo);
  app.use(responseFormatter);

  app.use('/api/public', parseBody, publicRouter);
  // The per-token limit → the token check → the per-user limit → the user's row: an over-budget
  // caller costs no database read.
  app.use(
    '/api/private',
    privateLimiter,
    verifyCognitoToken,
    privateUserLimiter,
    loadCognitoUser,
    parseBody,
    privateRouter,
  );
  // MCP sign-in: public OAuth endpoints and discovery. Before /api/mcp, which would swallow them.
  app.use('/.well-known', parseBody, wellKnownRouter);
  app.use('/api/mcp/oauth', parseBody, mcpOAuthRouter);
  app.use('/api/mcp', parseBody, mcpRouter, mcpBodyErrors); // agent keys, not Cognito

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
