import { Router } from 'express';
import { QueryController } from '../../controllers/index.js';
import type { QueryRequest, QueryResult } from '../../types/builder.js';

// Mounted at /workspaces/:wid/query behind requireWorkspace('viewer') (routes/private/index.ts).
const router = Router({ mergeParams: true });

// ─── POST /api/private/workspaces/:wid/query ────────────────────────────────

/**
 * Exactly one of `{savedQueryId}`, `{dashboardId, blockId}` (the draft for editors, the published
 * dashboard for viewers) or `{draft}`, plus optional runtime `vars` (`{"$page.area": "work"}`,
 * overriding the dashboard's defaults) and `preview` (at most 20 rows, 2 s). A draft may name its
 * `blockType`, so a query without a dateField gets the same default as the saved block (a
 * calendar: `any`). Validated with QueryRequestSchema (`@api-types/builder`).
 *
 * 400 `{message}`: an invalid request or query, as `<JSON pointer>: <reason>` (never a value).
 * 404: unknown workspace (or not a member), dashboard, block or view.
 */
export type RunQueryRequestBody = QueryRequest;

/** `{rows | groups, total, appliedVars, warnings}`. Every row carries `source.url`. */
export type RunQueryResponseData = QueryResult;

router.post('/', QueryController.runQuery);

export { router as queryRouter };
