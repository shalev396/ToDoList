import type { z } from 'zod';

import { AppError } from '../errors/AppError.js';
import { safeSegment } from '../utils/validation.js';

/** RFC 6901 JSON pointer of a path: `['where', 'rules', 0]` → `/where/rules/0`. */
export function toPointer(path: readonly PropertyKey[]): string {
  return path
    .map((segment) => `/${safeSegment(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}

/**
 * A query (or block, or dashboard) the Logic Bridge refuses. The message says where, as a JSON
 * pointer, and why; it never repeats the offending value, so it is safe to show people and agents.
 * Controllers answer it with a 400.
 */
export class QueryValidationError extends Error {
  /** JSON pointer to the offending part; '' is the whole document. */
  readonly pointer: string;
  readonly reason: string;

  constructor(pointer: string, reason: string) {
    super(pointer === '' ? reason : `${pointer}: ${reason}`);
    this.name = 'QueryValidationError';
    this.pointer = pointer;
    this.reason = reason;
  }

  /** The same error located inside a larger document, e.g. under `/draft`. */
  under(prefix: string): QueryValidationError {
    return new QueryValidationError(`${prefix}${this.pointer}`, this.reason);
  }
}

/**
 * A builder op (or the dashboard it produces) the Logic Bridge refuses: an op that names a missing
 * block, or a result that fails the schema, the catalog, the compiler, the caps or a blocking lint
 * rule. `pointer` locates it: `/ops/<i>/…` for an op, `/blocks/<i>/…` (and so on) for the dashboard.
 * Like QueryValidationError, the message never repeats a value. An AppError(400), so it is a 400
 * wherever it surfaces; controllers add the pointer to the body.
 */
export class OpValidationError extends AppError {
  /** JSON pointer to the offending part; '' is the whole document. */
  readonly pointer: string;
  readonly reason: string;

  constructor(pointer: string, reason: string) {
    super(400, pointer === '' ? reason : `${pointer}: ${reason}`);
    this.name = 'OpValidationError';
    this.pointer = pointer;
    this.reason = reason;
  }
}

type Issue = z.core.$ZodIssue;

/** How far a union branch got: its first issue's path length. */
function depth(branch: readonly Issue[]): number {
  return branch[0]?.path.length ?? 0;
}

/**
 * The issue to report, located from the document root. A failed union (a rule or a group?) holds
 * one issue list per branch: the branch with the fewest issues, then the deepest, is the one the
 * input was meant to be, so its first issue is the useful one.
 */
function locate(
  issue: Issue,
  base: readonly PropertyKey[],
): { path: PropertyKey[]; reason: string } {
  const path = [...base, ...issue.path];
  if (issue.code === 'invalid_union') {
    let best: Issue[] | undefined;
    for (const branch of issue.errors) {
      if (branch.length === 0) continue;
      const better =
        best === undefined ||
        branch.length < best.length ||
        (branch.length === best.length && depth(branch) > depth(best));
      if (better) best = branch;
    }
    const first = best?.[0];
    if (first !== undefined) return locate(first, path);
    if (issue.discriminator !== undefined) {
      // zod 4 already ends the path with the discriminator key (`["op"]`): don't add it twice.
      const at = path.at(-1) === issue.discriminator ? path : [...path, issue.discriminator];
      return { path: at, reason: `unknown ${issue.discriminator}` };
    }
  }
  if (issue.code === 'invalid_key') {
    const first = issue.issues[0];
    if (first !== undefined) return { path, reason: `key ${first.message}` };
  }
  return { path, reason: issue.message };
}

/** A failed zod parse as a QueryValidationError on its most useful issue. */
export function fromZodError(error: z.ZodError): QueryValidationError {
  const first = error.issues[0];
  if (first === undefined) return new QueryValidationError('', 'invalid');
  const { path, reason } = locate(first, []);
  return new QueryValidationError(toPointer(path), reason);
}

/** Every issue of a failed zod parse, located as fromZodError locates the first one. */
export function zodIssues(error: z.ZodError): { pointer: string; reason: string }[] {
  return error.issues.map((issue) => {
    const { path, reason } = locate(issue, []);
    return { pointer: toPointer(path), reason };
  });
}
