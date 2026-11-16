/**
 * The MCP endpoints (MCP.md §3, §11): POST /api/mcp and POST /api/mcp/readonly, mounted beside
 * /api/private on the same Express app, without Cognito: agents authenticate with agent keys.
 *
 * Stateless: every request gets a fresh server from the registry, built for its principal, and a
 * fresh transport; it is answered with one JSON body and nothing is kept. There are no sessions
 * and no SSE: GET and DELETE answer 405, and subscriptions/listen is refused. Both protocol
 * revisions are served from the same registry:
 *   - 2026-07-28 (per-request `_meta` envelope): the SDK's createMcpHandler, in `json` mode;
 *   - 2025 (initialize handshake): a Streamable HTTP transport per request, with
 *     `sessionIdGenerator: undefined` and JSON responses.
 *
 * The chain, per request: mcpAuth (key → principal; only a failed key counts against its address's
 * failed-authentication limit, and a valid key is never held off by it) → agentLimiter (per agent)
 * → request checks → scope guard (refused calls are audited) → MCP (only the tools the principal
 * may call; per call: confirm → handler → secret guard → audit) → the secret guard again, over the
 * whole JSON-RPC response.
 */
import {
  Router,
  type ErrorRequestHandler,
  type Request as HttpRequest,
  type RequestHandler,
} from 'express';
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
  type McpRequestContext,
  type McpServer,
} from '@modelcontextprotocol/server';
import { toNodeHandler, type FetchLikeMcpHandler } from '@modelcontextprotocol/node';

import { SecretLeakError } from '../errors/AppError.js';
import { logger } from '../services/logger.js';
import { findSecrets } from '../services/secretPatterns.js';
import { createMcpAuth } from './auth/apiKey.js';
import { mcpResource } from './oauth/urls.js';
import { requestAgent, type AuthenticatedAgent } from './auth/principal.js';
import { screenToolCall, toolCallOf } from './callGuard.js';
import { jsonRpcError, JSON_RPC, methodOf, requestIdOf, type JsonRpcId } from './jsonRpc.js';
import { recordToolCall } from './middleware/audit.js';
import { agentLimiter, AuthFailureLimit, type Limit } from './middleware/limiter.js';
import { blockSecrets } from './middleware/redact.js';
import { buildServer, findTool } from './registry.js';

// ─── The principal, through the SDK ─────────────────────────────────────────

const AGENT_KEY = 'todolistAgent';
/** Agents this module put into an AuthInfo: the factory accepts nothing else. */
const issued = new WeakSet();

/** The SDK hands `authInfo` to the server factory untouched: the authenticated agent rides in it. */
function toAuthInfo(agent: AuthenticatedAgent): AuthInfo {
  issued.add(agent);
  return {
    // The raw key never travels past mcpAuth: nothing downstream needs it.
    token: '',
    clientId: agent.principal.agentId,
    scopes: [...agent.principal.scopes],
    extra: { [AGENT_KEY]: agent },
  };
}

function agentOf(authInfo: AuthInfo | undefined): AuthenticatedAgent {
  const agent = authInfo?.extra?.[AGENT_KEY];
  if (typeof agent !== 'object' || agent === null || !issued.has(agent)) {
    throw new Error('MCP server requested without an authenticated agent');
  }
  return agent as AuthenticatedAgent;
}

type ServerFactory = (ctx: McpRequestContext) => McpServer;

function serverFactory(readonly: boolean): ServerFactory {
  return (ctx) => {
    const { principal, workspace, caller } = agentOf(ctx.authInfo);
    return buildServer({ readonly, principal, workspace, caller });
  };
}

// ─── Serving one request ────────────────────────────────────────────────────

/** 2025-era request: one server and one transport for this request, a JSON answer, then both closed. */
async function serveLegacy(
  factory: ServerFactory,
  request: Request,
  options: McpHandlerRequestOptions,
): Promise<Response> {
  const server = factory({
    era: 'legacy',
    requestInfo: request,
    ...(options.authInfo === undefined ? {} : { authInfo: options.authInfo }),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, options);
  } finally {
    await server.close();
  }
}

/**
 * The 2026-07-28 handler, made on first use: createMcpHandler warns about `json` mode once when
 * it is created, and most processes that import the app never serve MCP.
 */
function lazyModernHandler(factory: ServerFactory): () => McpHttpHandler {
  let handler: McpHttpHandler | undefined;
  return () => {
    handler ??= createMcpHandler(factory, {
      legacy: 'reject',
      responseMode: 'json',
      onerror: (error) => {
        logger.warn('[mcp] request rejected or failed', error);
      },
    });
    return handler;
  };
}

/** The request id to answer with: never one that is itself token-shaped. */
function safeId(body: unknown): JsonRpcId {
  const id = requestIdOf(body);
  return id !== null && findSecrets(id).length > 0 ? null : id;
}

/** True when the whole answer must be withheld. On local/dev/qa the guard's throw is logged, loud. */
function blocksAnswer(payload: unknown): boolean {
  try {
    return blockSecrets(payload, 'an MCP response');
  } catch (error) {
    if (!(error instanceof SecretLeakError)) throw error;
    logger.error('[mcp] response blocked', error);
    return true;
  }
}

/**
 * The secret guard over the whole answer: whatever the SDK produced (tool results, its own error
 * messages, lists, the echoed request id) passes findSecrets before it is written. A blocked
 * answer becomes a JSON-RPC 500 that echoes nothing token-shaped; when it answered a tool call,
 * the call (already audited when it ran) gets a second audit entry, `blocked`.
 */
async function guarded(
  response: Response,
  body: unknown,
  agent: AuthenticatedAgent,
): Promise<Response> {
  if (response.body === null) return response;
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // Not JSON: the text itself is scanned.
  }
  if (!blocksAnswer(payload)) {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const call = toolCallOf(body);
  const tool = call === null ? undefined : findTool(call.name);
  if (call !== null && tool !== undefined) {
    await recordToolCall(agent.caller, tool.name, call.args, 'blocked');
  }
  return Response.json(jsonRpcError(safeId(body), JSON_RPC.internalError, 'Internal error'), {
    status: 500,
  });
}

function mcpHttpHandler(readonly: boolean): FetchLikeMcpHandler {
  const factory = serverFactory(readonly);
  const modern = lazyModernHandler(factory);
  return {
    fetch: async (request, options = {}): Promise<Response> => {
      const agent = agentOf(options.authInfo);
      const response = (await isLegacyRequest(request, options.parsedBody))
        ? await serveLegacy(factory, request, options)
        : await modern().fetch(request, options);
      return guarded(response, options.parsedBody, agent);
    },
  };
}

function endpoint(readonly: boolean): RequestHandler {
  const serve = toNodeHandler(mcpHttpHandler(readonly), {
    onerror: (error) => {
      logger.error('[mcp] request failed', error);
    },
  });
  return async (req, res): Promise<void> => {
    (req as HttpRequest & { auth?: AuthInfo }).auth = toAuthInfo(requestAgent(res));
    await serve(req, res, req.body);
  };
}

// ─── Checks before the SDK ──────────────────────────────────────────────────

/** What this endpoint does not serve, refused before any server is built. */
const requestChecks: RequestHandler = (req, res, next) => {
  if (typeof req.is('application/json') !== 'string') {
    res
      .status(415)
      .json(
        jsonRpcError(null, JSON_RPC.serverError, 'Unsupported media type: send application/json'),
      );
    return;
  }
  if (Array.isArray(req.body)) {
    res
      .status(400)
      .json(
        jsonRpcError(
          null,
          JSON_RPC.invalidRequest,
          'Batches are not supported: send one JSON-RPC message per request',
        ),
      );
    return;
  }
  if (methodOf(req.body) === 'subscriptions/listen') {
    res.json(
      jsonRpcError(
        requestIdOf(req.body),
        JSON_RPC.methodNotFound,
        'Method not found: this server is stateless and has no subscriptions; poll instead',
      ),
    );
    return;
  }
  next();
};

/**
 * Scope guard for calls (callGuard.ts): a call to a tool that isn't in the catalog, or that the
 * principal may not call here, is refused before any server is built, and audited.
 */
function scopeGuard(readonly: boolean): RequestHandler {
  return async (req, res, next): Promise<void> => {
    const refusal = await screenToolCall(req.body, requestAgent(res), readonly);
    if (refusal === null) {
      next();
      return;
    }
    res.json(jsonRpcError(safeId(req.body), refusal.code, refusal.message));
  };
}

const methodNotAllowed: RequestHandler = (_req, res) => {
  res
    .status(405)
    .set('Allow', 'POST')
    .json(
      jsonRpcError(
        null,
        JSON_RPC.serverError,
        'Method not allowed: this endpoint is stateless and answers POST only',
      ),
    );
};

/** Anything thrown on the way (the database, say) answers a generic JSON-RPC 500. */
const mcpErrorHandler: ErrorRequestHandler = (error: unknown, req, res, next): void => {
  if (res.headersSent) {
    next(error);
    return;
  }
  logger.error('[mcp] request failed', error);
  res
    .status(500)
    .json(jsonRpcError(requestIdOf(req.body), JSON_RPC.internalError, 'Internal error'));
};

/**
 * Body-parser failures on /api/mcp (malformed JSON, a body too large), as JSON-RPC errors. app.ts
 * mounts it after mcpRouter: parseBody runs before the router, so its errors pass the router by
 * and land here. Never echoes the body.
 */
export const mcpBodyErrors: ErrorRequestHandler = (error: unknown, _req, res, next): void => {
  const { status, type } = (typeof error === 'object' && error !== null ? error : {}) as {
    status?: unknown;
    type?: unknown;
  };
  if (res.headersSent || typeof status !== 'number' || status < 400 || status >= 500) {
    next(error);
    return;
  }
  if (type === 'entity.parse.failed') {
    res
      .status(400)
      .json(jsonRpcError(null, JSON_RPC.parseError, 'Parse error: the body is not valid JSON'));
    return;
  }
  const message = type === 'entity.too.large' ? 'Request body too large' : 'Invalid request body';
  res.status(status).json(jsonRpcError(null, JSON_RPC.invalidRequest, message));
};

// ─── The router ─────────────────────────────────────────────────────────────

export interface McpRouterOptions {
  /** Requests per agent key (default AGENT_LIMIT); one budget across both endpoints. */
  agentLimit?: Limit;
  /** Failed authentications per address (default AUTH_FAILURE_LIMIT). */
  authFailureLimit?: Limit;
}

/** `/` → /api/mcp, `/readonly` → /api/mcp/readonly, once mounted at /api/mcp behind parseBody. */
export function createMcpRouter(options: McpRouterOptions = {}): Router {
  const router = Router();
  const mcpAuth = createMcpAuth(new AuthFailureLimit(options.authFailureLimit), (req) =>
    mcpResource(req.path.startsWith('/readonly')),
  );
  const perAgent = agentLimiter(options.agentLimit);
  for (const [path, readonly] of [
    ['/readonly', true],
    ['/', false],
  ] as const) {
    router.post(path, mcpAuth, perAgent, requestChecks, scopeGuard(readonly), endpoint(readonly));
    router.all(path, methodNotAllowed);
  }
  router.use(mcpErrorHandler);
  return router;
}

export const mcpRouter: Router = createMcpRouter();
