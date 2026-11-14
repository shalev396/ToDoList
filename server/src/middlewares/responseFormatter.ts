import {
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
  type ErrorRequestHandler,
} from 'express';
/// <reference path="../types/express-extensions.d.ts" />
import { environment } from '../config/environment.js';
import { AppError, SecretLeakError } from '../errors/AppError.js';
import { logger } from '../services/logger.js';
import { findSecrets, redactString, type SecretKind } from '../services/secretPatterns.js';
import type { ErrorCode } from '../types/errorCodes.js';
import type { ApiErrorResponse } from '../types/response.js';
import { hasSensitiveBody } from './sensitiveBody.js';

const ALLOW_KEY = 'secretGuardAllow';

/** `{ message }`, plus the machine code when there is one (the client translates it). */
function errorBody(message: string, code: ErrorCode | undefined): ApiErrorResponse {
  return code === undefined ? { message } : { message, code };
}

/**
 * Lets the current response carry a secret kind it legitimately returns: `jwt` for the session
 * tokens of login/refresh, `agent_key` for the single response that shows a new agent key.
 */
export function allowSecretKinds(res: Response, ...kinds: SecretKind[]): void {
  const current = (res.locals[ALLOW_KEY] as SecretKind[] | undefined) ?? [];
  res.locals[ALLOW_KEY] = [...current, ...kinds];
}

/**
 * `res.success(data)` → `{ data }` and `res.error(message, status, code?)` → `{ message, code? }`.
 *
 * Every success body passes the secret guard (DATA.md §0.4): a token-shaped value or a deny-listed
 * key throws in local/dev/qa (the bug is loud) and becomes a generic 500 on prod. Error messages
 * are redacted before they are sent.
 */
export const responseFormatter: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  res.success = function (data: unknown, statusCode = 200): void {
    const hits = findSecrets(data, {
      allow: (this.locals[ALLOW_KEY] as SecretKind[] | undefined) ?? [],
    });
    if (hits.length > 0) {
      logger.error('[secret-guard] blocked a response', {
        method: req.method,
        path: req.path,
        hits,
      });
      if (environment.env === 'prod') {
        this.status(500).json({ message: 'Internal server error' });
        return;
      }
      throw new SecretLeakError(hits.map((hit) => `${hit.path} (${hit.kind})`));
    }
    this.status(statusCode).json({ data });
  };

  res.error = function (message: string, statusCode = 500, code?: ErrorCode): void {
    this.status(statusCode).json(errorBody(redactString(message), code));
  };

  next();
};

interface HttpErrorLike {
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
  expose?: unknown;
}

/** Client errors raised by Express's body parsers (malformed JSON, too large, bad charset…). */
function parserError(error: unknown): { status: number; message: string } | null {
  if (typeof error !== 'object' || error === null) return null;
  const { status, type, expose } = error as HttpErrorLike;
  if (typeof status !== 'number' || status < 400 || status >= 500 || expose !== true) return null;
  if (type === 'entity.parse.failed') return { status, message: 'Malformed JSON body' };
  if (type === 'entity.too.large') return { status, message: 'Request body too large' };
  return { status, message: 'Invalid request body' };
}

/** The only answers on a route marked sensitiveBody: nothing of the error reaches the client. */
const SENSITIVE_ANSWERS: Readonly<Record<number, string>> = {
  400: 'Invalid request body',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  413: 'Request body too large',
  429: 'Too many requests',
};

/**
 * A request whose body is a secret: a fixed message per status, and for a server error a log line
 * with the error's name and status only. Its message, stack and cause could quote the body.
 */
function answerSensitive(error: unknown, req: Request, res: Response): void {
  const status = error instanceof AppError ? error.statusCode : (parserError(error)?.status ?? 500);
  if (status >= 500) {
    logger.error(`${req.method} ${req.path} failed`, {
      errorName: error instanceof Error ? error.name : typeof error,
      statusCode: status,
    });
    res.status(status).json({ message: 'Internal server error' });
    return;
  }
  // The machine code is a fixed value from ERROR_CODES, never request text.
  const code = error instanceof AppError ? error.code : undefined;
  res.status(status).json(errorBody(SENSITIVE_ANSWERS[status] ?? 'Request refused', code));
}

/**
 * Last-resort error handler. Express 5 only calls error handlers declared with four parameters.
 * Responds with `{ message, code? }`: the AppError message (and its machine code) for expected
 * errors, a fixed text for parser errors, a generic 500 otherwise. Never echoes the request body;
 * logs are redacted.
 */
export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (hasSensitiveBody(res)) {
    answerSensitive(error, req, res);
    return;
  }
  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      // Server-side detail (driver, host, provider text) stays in the redacted log.
      logger.error(`${req.method} ${req.path} failed`, error);
      res.status(error.statusCode).json({ message: 'Internal server error' });
      return;
    }
    res.status(error.statusCode).json(errorBody(redactString(error.message), error.code));
    return;
  }
  const clientError = parserError(error);
  if (clientError !== null) {
    res.status(clientError.status).json({ message: clientError.message });
    return;
  }
  logger.error(`${req.method} ${req.path} failed`, error);
  res.status(500).json({ message: 'Internal server error' });
};

export const notFound: RequestHandler = (_req: Request, res: Response): void => {
  res.status(404).json({
    message: 'Not found',
  });
};
