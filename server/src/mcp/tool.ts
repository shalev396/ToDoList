/**
 * The shape of one MCP tool (MCP.md §11.2): its contract (name, schemas, annotations), who may
 * call it (scopes, minimum role) and its handler. Tools live in tools/<toolset>/ and are listed,
 * in a fixed order, by registry.ts.
 */
import type { z } from 'zod';

import type { Caller, WorkspaceContext } from '../classes/base/Caller.js';
import type { AgentScope, Role } from '../types/domain.js';
import type { AgentPrincipal } from './auth/principal.js';

/** Toolsets in catalog order (MCP.md §7): tools/list follows it. */
export const TOOLSETS = ['read', 'items', 'sync', 'integrations', 'workspace', 'builder'] as const;
export type Toolset = (typeof TOOLSETS)[number];

/** Every tool sets all four hints (MCP.md §2: annotations on every tool). */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** What a call runs with. */
export interface ToolContext {
  /** Its `scopes` are the ones this endpoint honours: read scopes only on /readonly. */
  principal: AgentPrincipal;
  /** The caller's standing in the workspace, as the services take it (requireWorkspace's shape). */
  workspace: WorkspaceContext;
  /**
   * The agent key as a caller, from this request's address and user agent (absent in contexts
   * tests build: auth/principal.ts toolCaller fills it in).
   */
  caller?: Caller;
  readonly: boolean;
  /** The clock. Tests inject one (the builder's preview window, D12). */
  now: () => Date;
}

/** The entity a call acted on, for the audit entry. Only ever a resolved id, never raw input. */
export interface AuditTarget {
  type: string;
  id: string;
}

export interface ToolOutcome<O> {
  /** The structured result: validated against the tool's outputSchema by the SDK. */
  output: O;
  target?: AuditTarget;
  /** The call changed nothing: a dry run or a preview. Audited as `preview`. */
  preview?: boolean;
  /**
   * How the call is audited when not plainly as `mcp.<tool>`: under another tool's action (a
   * builder dry run is a builder_preview, D12) and with extra meta (plain names, string values).
   */
  audit?: { action?: string; meta?: Record<string, string> };
}

export interface ToolDef<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  /** snake_case, unique. */
  name: string;
  title: string;
  /** The static contract an agent reads: what the tool does and returns, never instructions. */
  description: string;
  toolset: Toolset;
  inputSchema: I;
  outputSchema: O;
  annotations: ToolAnnotations;
  /** All of these are needed (after scopes ∩ role). */
  scopes: readonly AgentScope[];
  minRole: Role;
  handler(ctx: ToolContext, input: z.output<I>): Promise<ToolOutcome<z.output<O>>>;
  /**
   * Destructive tools only: the change `handler` would make, worked out without making it. Called
   * instead of the handler when the input lacks `confirm: true` (middleware/confirm.ts).
   */
  preview?(ctx: ToolContext, input: z.output<I>): Promise<ToolOutcome<z.output<O>>>;
  /**
   * Destructive tools whose inputs are not all destructive: true when this input needs
   * `confirm` (builder_apply_template: only mode replace). Default: every input does.
   */
  needsConfirm?(input: z.output<I>): boolean;
}

/** Identity, for inference: `defineTool({...})` checks the handler against the schemas. */
export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(
  def: ToolDef<I, O>,
): ToolDef<I, O> {
  return def;
}
