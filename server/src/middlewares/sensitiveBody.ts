/**
 * For a route whose request body is a secret (`PUT …/integrations/:iid/credential`, DATA.md §7:
 * "the request body for that route is excluded from logs and error handlers"). Put `sensitiveBody`
 * first on the route:
 * - The body leaves `req.body`, which becomes `{}`: no later middleware, logger or error handler
 *   can see it. The handler takes it once, with takeSensitiveBody(req).
 * - The error handler (responseFormatter.ts) answers a marked request with a fixed message per
 *   status and logs only the error's name and status, never its message, stack or cause, which
 *   could quote the body.
 */
import type { Request, RequestHandler, Response } from 'express';

const MARK = 'sensitiveBody';

/** Bodies of marked requests, until their handler takes them (gone with the request). */
const bodies = new WeakMap<Request, unknown>();

export const sensitiveBody: RequestHandler = (req, res, next) => {
  (res.locals as Record<string, unknown>)[MARK] = true;
  const body: unknown = req.body;
  bodies.set(req, body);
  req.body = {};
  next();
};

/** Whether the request was marked with sensitiveBody. */
export function hasSensitiveBody(res: Response): boolean {
  return (res.locals as Record<string, unknown>)[MARK] === true;
}

/** The marked request's body. Only once: a second call gets undefined. */
export function takeSensitiveBody(req: Request): unknown {
  const body = bodies.get(req);
  bodies.delete(req);
  return body;
}
