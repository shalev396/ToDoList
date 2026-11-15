/**
 * One tool call (MCP.md §11.3, per call): scope guard → argument validation → confirm → handler
 * → secret guard → audit. The rules themselves live in the services; here a refusal or failure
 * becomes an `isError` result with a plain message (the AppError's text, or a generic one), so the
 * agent can read it and correct its call. Every call is audited, refused or invalid ones too.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';

import { issueText } from '../utils/validation.js';

import { QueryValidationError } from '../builder/errors.js';
import { AppError } from '../errors/AppError.js';
import { ConflictError } from '../errors/ConflictError.js';
import { FieldNotWritableError } from '../errors/FieldNotWritableError.js';
import { MirroredItemError } from '../errors/MirroredItemError.js';
import { MirroredItemError as StoredMirroredItemError } from '../models/errors.js';
import { logger } from '../services/logger.js';
import { redactString } from '../services/secretPatterns.js';
import { toolCaller } from './auth/principal.js';
import { canCall } from './auth/scopes.js';
import { recordToolCall, type AuditExtra, type ResultStatus } from './middleware/audit.js';
import { runConfirmed } from './middleware/confirm.js';
import { blockSecrets } from './middleware/redact.js';
import type { AuditTarget, ToolContext, ToolDef } from './tool.js';

/** Results are size-capped (MCP.md §5.9): a larger one is refused, and the agent narrows its call. */
export const MAX_RESULT_CHARS = 200_000;

/**
 * Inputs are capped too: at most this many array elements and object members in one call's
 * arguments. Checked here rather than by the SDK, so a refused call is audited like any other.
 */
export const MAX_TOOL_INPUT_ELEMENTS = 1000;

/** Array elements plus object members, at every depth; counting stops once it passes `cap`. */
export function inputElements(value: unknown, cap: number): number {
  let count = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0 && count <= cap) {
    const node = pending.pop();
    if (typeof node !== 'object' || node === null) continue;
    const children: unknown[] = Array.isArray(node)
      ? (node as unknown[])
      : Object.values(node as Record<string, unknown>);
    count += children.length;
    pending.push(...children);
  }
  return Math.min(count, cap + 1);
}

export const INTERNAL_ERROR_MESSAGE = 'Internal error: the call did not complete.';

interface ToolCall {
  result: CallToolResult;
  status: ResultStatus;
  target?: AuditTarget | undefined;
  audit?: AuditExtra | undefined;
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * The first problem and where it is (`email: …`), like the REST routes' 400s. zod's messages say
 * what was expected, never the value received.
 */
function invalidArguments(error: z.ZodError): string {
  const [issue] = error.issues;
  if (issue === undefined) return 'Invalid arguments';
  return `Invalid arguments: ${issueText(issue)}`;
}

/** Mirrored items are edited at their source (MCP.md §5.7): say where, as the REST 409 does. */
function mirrored(provider: string, url: string): ToolCall {
  return {
    result: errorResult(
      `This item is mirrored from ${provider} and can only be edited there. Open in ${provider}: ${url}`,
    ),
    status: 'error',
  };
}

function failure(tool: string, error: unknown): ToolCall {
  if (error instanceof StoredMirroredItemError) return mirrored(error.provider, error.url);
  if (error instanceof MirroredItemError) {
    return mirrored(error.openIn.provider, error.openIn.url);
  }
  if (error instanceof FieldNotWritableError && error.openIn !== null) {
    // Which fields, and where they are changed instead.
    const { provider, url } = error.openIn;
    return {
      result: errorResult(`${redactString(error.message)}. Open in ${provider}: ${url}`),
      status: 'error',
    };
  }
  if (error instanceof ConflictError) {
    const current = String(error.currentVersion);
    return {
      result: errorResult(
        `Version conflict: the dashboard changed since you read it (currentVersion: ${current}). Read it again, then retry with expectedVersion ${current}.`,
      ),
      status: 'error',
    };
  }
  if (error instanceof QueryValidationError) {
    return { result: errorResult(redactString(error.message)), status: 'error' };
  }
  if (error instanceof AppError && error.statusCode < 500) {
    return { result: errorResult(redactString(error.message)), status: 'error' };
  }
  logger.error(`[mcp] tool ${tool} failed`, error);
  const outcome = error instanceof AppError ? providerOutcome(error) : null;
  return { result: errorResult(outcome ?? INTERNAL_ERROR_MESSAGE), status: 'error' };
}

/** A provider id as an error names it (`jira`, `google_calendar`): one plain token, else none. */
const PROVIDER_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * The two server errors whose outcome the agent must know, like the REST codes it keeps: a write
 * the provider never answered may have been made there (`provider_no_answer`); a provider that
 * could not be reached changed nothing (`provider_unreachable`). Fixed text naming the provider
 * (when the error carries its id), nothing else of the error. Null for any other server error.
 */
function providerOutcome(error: AppError): string | null {
  const named = (error as { provider?: unknown }).provider;
  const provider = typeof named === 'string' && PROVIDER_NAME.test(named) ? named : 'the provider';
  if (error.code === 'provider_no_answer') {
    return `${provider} did not answer: the change may have been made at ${provider}. Check there before you try again.`;
  }
  if (error.code === 'provider_unreachable') {
    return `${provider} could not be reached: nothing was changed. Try again in a moment.`;
  }
  return null;
}

async function execute<I extends z.ZodObject, O extends z.ZodObject>(
  tool: ToolDef<I, O>,
  ctx: ToolContext,
  args: unknown,
): Promise<ToolCall> {
  const access = {
    scopes: tool.scopes,
    minRole: tool.minRole,
    readOnly: tool.annotations.readOnlyHint,
  };
  // The registry registers only what the principal may call; this is the second check.
  if (!canCall(access, ctx.principal, { readonly: ctx.readonly })) {
    return { result: errorResult(`This agent key may not call ${tool.name}.`), status: 'denied' };
  }
  // The SDK lets every call through (registry.ts): the arguments are checked here, first.
  if (inputElements(args, MAX_TOOL_INPUT_ELEMENTS) > MAX_TOOL_INPUT_ELEMENTS) {
    return {
      result: errorResult(
        `The arguments hold too many elements (at most ${String(MAX_TOOL_INPUT_ELEMENTS)}). Send less and call again.`,
      ),
      status: 'refused',
    };
  }
  const parsed = tool.inputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return { result: errorResult(invalidArguments(parsed.error)), status: 'error' };
  }
  try {
    const outcome = await runConfirmed(tool, ctx, parsed.data);
    const text = JSON.stringify(outcome.output);
    if (text.length > MAX_RESULT_CHARS) {
      return {
        result: errorResult('The result is too large. Narrow the request and call again.'),
        status: 'error',
      };
    }
    return {
      result: { content: [{ type: 'text', text }], structuredContent: outcome.output },
      status: outcome.applied && outcome.preview !== true ? 'ok' : 'preview',
      target: outcome.target,
      audit: outcome.audit,
    };
  } catch (error) {
    return failure(tool.name, error);
  }
}

/**
 * Runs one call and records it, hashing the arguments as the agent sent them. A result or error
 * carrying secret-shaped data never leaves: the guard throws on local/dev/qa (the SDK reports the
 * throw as a tool error naming only paths and kinds) and is answered with a generic error on prod.
 * Either way the call is audited as `blocked`.
 */
export async function runTool<I extends z.ZodObject, O extends z.ZodObject>(
  tool: ToolDef<I, O>,
  ctx: ToolContext,
  args: unknown,
): Promise<CallToolResult> {
  const call = await execute(tool, ctx, args);
  let blocked: boolean;
  try {
    blocked = blockSecrets(call.result, `the result of MCP tool ${tool.name}`);
  } catch (error) {
    await recordToolCall(toolCaller(ctx), tool.name, args, 'blocked');
    throw error;
  }
  if (blocked) {
    await recordToolCall(toolCaller(ctx), tool.name, args, 'blocked');
    return errorResult(INTERNAL_ERROR_MESSAGE);
  }
  await recordToolCall(toolCaller(ctx), tool.name, args, call.status, call.target, call.audit);
  return call.result;
}
