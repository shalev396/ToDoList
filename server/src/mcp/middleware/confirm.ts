/**
 * Confirmation for destructive tools (MCP.md §5.6). A tool with `destructiveHint: true` runs its
 * handler only when called with `confirm: true`; otherwise its preview runs instead, which works
 * out the change without making it. The gate sits outside the tools, so a destructive tool can't
 * forget it, and the registry refuses a destructive tool without a preview or a `confirm` input.
 */
import { z } from 'zod';

import type { ToolContext, ToolDef, ToolOutcome } from '../tool.js';

/** The `confirm` input field of every destructive tool. */
export const confirmField = z
  .boolean()
  .optional()
  .describe('true applies the change. Without it nothing changes: the result is a preview.');

export function isConfirmed(input: unknown): boolean {
  return (
    typeof input === 'object' && input !== null && (input as { confirm?: unknown }).confirm === true
  );
}

export interface GatedOutcome<O> extends ToolOutcome<O> {
  /** false: the preview ran and nothing changed. */
  applied: boolean;
}

/** Runs the handler, or for a destructive tool without `confirm: true`, the preview instead. */
export async function runConfirmed<I extends z.ZodObject, O extends z.ZodObject>(
  tool: ToolDef<I, O>,
  ctx: ToolContext,
  input: z.output<I>,
): Promise<GatedOutcome<z.output<O>>> {
  const gated = tool.annotations.destructiveHint && (tool.needsConfirm?.(input) ?? true);
  if (!gated || isConfirmed(input)) {
    return { ...(await tool.handler(ctx, input)), applied: true };
  }
  if (tool.preview === undefined) throw new Error(`Destructive tool ${tool.name} has no preview`);
  return { ...(await tool.preview(ctx, input)), applied: false };
}

/** Registry invariant: a destructive tool takes `confirm` and has a preview. */
export function assertConfirmable(tool: ToolDef): void {
  if (!tool.annotations.destructiveHint) return;
  if (tool.preview === undefined) throw new Error(`Destructive tool ${tool.name} has no preview`);
  if (!('confirm' in tool.inputSchema.shape)) {
    throw new Error(`Destructive tool ${tool.name} does not take confirm`);
  }
}
