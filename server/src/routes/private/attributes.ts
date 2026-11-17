import { Router } from 'express';
import { AttributesController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';
import type { AttributeDef, AttributePatch, NewAttribute } from '../../types/attributes.js';

/**
 * Custom attributes (H4): fields every item of the workspace can carry, with the built-in
 * Importance (1-5) in every workspace. Everyone reads the definitions; editors define them. The
 * values live in the item overlay (PATCH …/items/:id/overlay `attrs`) and never reach a provider.
 */
const router = Router();

// ─── GET /api/private/workspaces/:wid/attributes ────────────────────────────

/** Viewer. The built-in first, then custom attributes in creation order. */
export type ListAttributesResponseData = AttributeDef[];

router.get('/workspaces/:wid/attributes', requireWorkspace('viewer'), AttributesController.list);

// ─── POST /api/private/workspaces/:wid/attributes ───────────────────────────

/**
 * Editor. 201 with the definition. 409 `attribute_exists` when the key is taken, 409
 * `attribute_limit` at the cap per workspace (PLAN_LIMITS.attributesPerWorkspace).
 */
export type CreateAttributeRequestBody = NewAttribute;
export type CreateAttributeResponseData = AttributeDef;

router.post('/workspaces/:wid/attributes', requireWorkspace('editor'), AttributesController.create);

// ─── PATCH /api/private/workspaces/:wid/attributes/:key ─────────────────────

/** Editor. Rename (the built-in too), or change a select's options or a number's range. */
export type UpdateAttributeRequestBody = AttributePatch;
export type UpdateAttributeResponseData = AttributeDef;

router.patch(
  '/workspaces/:wid/attributes/:key',
  requireWorkspace('editor'),
  AttributesController.update,
);

// ─── DELETE /api/private/workspaces/:wid/attributes/:key ────────────────────

/** Editor. Removes the definition and the values items hold. 409 `attribute_builtin` for Importance. */
export interface DeleteAttributeResponseData {
  items: number;
}

router.delete(
  '/workspaces/:wid/attributes/:key',
  requireWorkspace('editor'),
  AttributesController.remove,
);

export { router as attributesRouter };
