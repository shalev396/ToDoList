import type { Request } from 'express';
import type { z } from 'zod';

import { AppError } from '../errors/AppError.js';
import { findSecrets } from '../services/secretPatterns.js';

/** A named route parameter (`:uid`); a missing or repeated one reads as "not found". */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value === '') throw new AppError(404, 'Not found');
  return value;
}

/**
 * Parses a request body or params with a zod schema: the parsed data, or a 400 that names the
 * first problem and where it is (`settings.timezone: …`). zod's messages describe what was
 * expected, never the value received, so nothing a client sent is echoed back.
 */
export function parseOr400<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const [issue] = result.error.issues;
  if (issue === undefined) throw new AppError(400, 'Invalid request');
  throw new AppError(400, issueText(issue));
}

type Issue = z.ZodError['issues'][number];

/**
 * A path segment as shown to the client: schema fields are short and plain; a long segment, or one
 * that looks like a secret, is client data and is replaced.
 */
export function safeSegment(part: PropertyKey): string {
  const text = String(part);
  return text.length > 40 || findSecrets(text).length > 0 ? '�' : text;
}

/**
 * `path: what was expected` for an issue. An unrecognized key is a fixed message (zod's names the
 * client's keys), and the path never echoes client data (safeSegment).
 */
export function issueText(issue: Issue, prefix: readonly PropertyKey[] = []): string {
  const where = [...prefix, ...issue.path].map(safeSegment).join('.');
  const message = issue.code === 'unrecognized_keys' ? 'Unrecognized key' : issue.message;
  return where === '' ? message : `${where}: ${message}`;
}
