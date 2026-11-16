/**
 * The limits and patterns of a workspace, as plain constants (no database): the request schemas
 * (services/workspaceSchemas.ts) and the classes of classes/workspace/ share them.
 */
export const WORKSPACE_NAME_MAX = 80;
export const SLUG_MIN = 2;
export const SLUG_MAX = 48;
/** Lowercase letters and digits in groups joined by single hyphens. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Invites expire 7 days after they are sent. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
