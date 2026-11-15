/**
 * A dashboard history's limits (DATA.md §3.12, MCP.md §13), as plain numbers: what the request
 * schemas and the tool descriptions quote, without loading the classes that apply them. Pure.
 */

/** Versions kept per dashboard, besides the published one. */
export const KEEP_VERSIONS = 50;

/** A whole copy of the dashboard is kept at version 1 and every 10th version. */
export const SNAPSHOT_EVERY = 10;

/** The most versions one undo reverts. */
export const MAX_UNDO_STEPS = 20;
