import { Router } from 'express';
import { TravelController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';

export type {
  CreatePlaceRequest,
  CreateTravelRuleRequest,
  LegEditRequest,
  MarkItemRequest,
  MarkItemResponse,
  PlacePinRequest,
  PlaceView,
  TravelDaysResponse,
  TravelLinksResponse,
  TravelPreviewRequest,
  TravelPreviewResponse,
  TravelRuleView,
  TravelSettingsResponse,
  UpdatePlaceRequest,
  UpdateTravelRuleRequest,
  UpdateTravelSettingsRequest,
} from '../../types/travel.js';

/**
 * Travel time (docs/superpowers/specs/2026-11-17-travel-time-design.md): the member's places,
 * rules and settings, marking an item for travel, a trip's preview, their legs and the day panel.
 * Full paths under /workspaces/:wid/travel, editors and owners only (plan Ruling 16): a viewer is
 * 403, a non-member 404. Everything is the caller's own: another member's place, rule or leg is a
 * 404, as one that never existed. Strict bodies (an unknown key is 400). Types: types/travel.ts.
 *
 * - A place's address is in its member's answers only (and a leg's own links, to its member; plan
 *   Ruling 10). Nothing is looked up: no route calls out (the owner's decision of 2026-11-18).
 * - A change to a place, a rule, the settings, a default place or a pin, a mark, a trip's length
 *   and a leg's reset make the member's legs again before they answer, so the next read agrees.
 * - A leg is a travel item (`GET …/items/:id` reads it too); it is never deleted, only skipped.
 */
const router = Router();

// ─── Places ─────────────────────────────────────────────────────────────────

/** The caller's places, oldest first (PlaceView[]: with their addresses). */
router.get(
  '/workspaces/:wid/travel/places',
  requireWorkspace('editor'),
  TravelController.listPlaces,
);

/**
 * CreatePlaceRequest → 201 PlaceView: a name, and an address as typed if any (never looked up:
 * it only opens a map app). `home` makes it the one Home. 409 `travel_limit` at 30.
 */
router.post(
  '/workspaces/:wid/travel/places',
  requireWorkspace('editor'),
  TravelController.createPlace,
);

/** UpdatePlaceRequest (any of it) → PlaceView. An empty address clears it. */
router.patch(
  '/workspaces/:wid/travel/places/:id',
  requireWorkspace('editor'),
  TravelController.updatePlace,
);

/** 204. Rules naming it name none, and pins to it go; without Home there are no legs. */
router.delete(
  '/workspaces/:wid/travel/places/:id',
  requireWorkspace('editor'),
  TravelController.removePlace,
);

// ─── Rules ──────────────────────────────────────────────────────────────────

/** TravelRuleView[], oldest first. */
router.get('/workspaces/:wid/travel/rules', requireWorkspace('editor'), TravelController.listRules);

/**
 * CreateTravelRuleRequest → 201 TravelRuleView. A where-group is checked as a dashboard query
 * (400); a place must be the caller's (400). 409 `travel_limit` at 50.
 */
router.post(
  '/workspaces/:wid/travel/rules',
  requireWorkspace('editor'),
  TravelController.createRule,
);

/** UpdateTravelRuleRequest (any of it) → TravelRuleView. */
router.patch(
  '/workspaces/:wid/travel/rules/:id',
  requireWorkspace('editor'),
  TravelController.updateRule,
);

/** 204. Its legs go, as no longer matching. */
router.delete(
  '/workspaces/:wid/travel/rules/:id',
  requireWorkspace('editor'),
  TravelController.removeRule,
);

// ─── Settings, default places and pins ──────────────────────────────────────

/** TravelSettingsResponse: the settings (the spec's defaults until changed), default places. */
router.get(
  '/workspaces/:wid/travel/settings',
  requireWorkspace('editor'),
  TravelController.getSettings,
);

/** UpdateTravelSettingsRequest (any part) → TravelSettingsResponse; checked whole (400). */
router.patch(
  '/workspaces/:wid/travel/settings',
  requireWorkspace('editor'),
  TravelController.updateSettings,
);

/** PlacePinRequest → 204: a calendar's or project's default place; null removes it. */
router.put(
  '/workspaces/:wid/travel/container-places/:containerId',
  requireWorkspace('editor'),
  TravelController.setContainerPlace,
);

/** PlacePinRequest → 204: an item's place ("set place"); null unpins it. */
router.put(
  '/workspaces/:wid/travel/item-places/:itemId',
  requireWorkspace('editor'),
  TravelController.pinItemPlace,
);

// ─── Marking an item, and the preview ───────────────────────────────────────

/**
 * MarkItemRequest → MarkItemResponse: the rule (every occurrence: a series rule; one occurrence
 * or an item that doesn't repeat: an item rule; marking the same again changes it) and the
 * item's legs. In `there` and `back`, `minutes` becomes the length of the trip each leg takes
 * (every leg of it follows) and times move that leg by hand. Any timed item takes travel, a
 * painted area too. 404 for an item the caller can't see; 400 for one that takes no travel (a
 * leg, no start, all day, cancelled) or a wrong occurrence; 409 `travel_home_missing` without a
 * Home.
 */
router.post(
  '/workspaces/:wid/travel/items/:itemId',
  requireWorkspace('editor'),
  TravelController.markItem,
);

/**
 * `?every=true` (every occurrence's marks) or `?occurrence=<original start>` (one; neither: the
 * item's own) → 204, and their legs go. 404 when there is no such mark.
 */
router.delete(
  '/workspaces/:wid/travel/items/:itemId',
  requireWorkspace('editor'),
  TravelController.unmarkItem,
);

/**
 * TravelPreviewRequest → TravelPreviewResponse: the trip's length as he set it, or the placeholder
 * with `lengthUnset` (no leg is made; from defaults to Home).
 */
router.post(
  '/workspaces/:wid/travel/preview',
  requireWorkspace('editor'),
  TravelController.preview,
);

// ─── Legs and days ──────────────────────────────────────────────────────────

/**
 * LegEditRequest → ItemDetail. `minutes`: how long its trip takes, every time (the legs are made
 * again: every leg of the trip follows, but the ones he timed by hand). `startAt`, `endAt`: this
 * leg only, his until he resets it.
 */
router.patch(
  '/workspaces/:wid/travel/legs/:id',
  requireWorkspace('editor'),
  TravelController.editLeg,
);

/** 204: skipped for its day (a tombstone, reason `skipped`, until Reset). */
router.post(
  '/workspaces/:wid/travel/legs/:id/skip',
  requireWorkspace('editor'),
  TravelController.skipLeg,
);

/** ItemDetail: computed again (a skip undone, his times and the "moved" flag cleared). */
router.post(
  '/workspaces/:wid/travel/legs/:id/reset',
  requireWorkspace('editor'),
  TravelController.resetLeg,
);

/** TravelLinksResponse: the apps that open the trip, worked out on read, its member's only. */
router.get(
  '/workspaces/:wid/travel/legs/:id/links',
  requireWorkspace('editor'),
  TravelController.legLinks,
);

/** `?from=YYYY-MM-DD&to=YYYY-MM-DD` (both included, at most 14 days) → TravelDaysResponse. */
router.get('/workspaces/:wid/travel/days', requireWorkspace('editor'), TravelController.days);

export { router as travelRouter };
