/**
 * The travel routes (routes/private/travel.ts): parse, one class, the view. A place is answered
 * through its member's view only (`Place#toView`), a profile through its settings view, never as
 * stored.
 */
import { type RequestHandler } from 'express';

import { ItemQuery, TravelLeg } from '../classes/item/index.js';
import { Place, TravelPlanner, TravelRule, TravelSetup } from '../classes/travel/index.js';
import {
  CreatePlaceBody,
  CreateRuleBody,
  DaysQuery,
  EmptyBody,
  LegEditBody,
  LegModeBody,
  MarkItemBody,
  PlacePinBody,
  PreviewBody,
  UnmarkItemQuery,
  UpdatePlaceBody,
  UpdateRuleBody,
  UpdateSettingsBody,
} from '../services/travelSchemas.js';
import { optionalTime } from '../services/timeBlockSchemas.js';
import type { WorkspaceRequest } from '../types/express.js';
import type { ItemDetail } from '../types/items.js';
import type {
  LegModeResponse,
  MarkItemResponse,
  PlaceView,
  TravelDaysResponse,
  TravelLinksResponse,
  TravelPreviewResponse,
  TravelRuleView,
  TravelSettingsResponse,
} from '../types/travel.js';
import { parseOr400, routeParam } from '../utils/validation.js';

// ─── Places ─────────────────────────────────────────────────────────────────

const listPlaces: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const data: PlaceView[] = (await Place.listOwn(caller)).map((place) => place.toView());
  res.success(data);
};

const createPlace: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreatePlaceBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const place = await TravelSetup.of(caller).addPlace(body);
  const data: PlaceView = place.toView();
  res.success(data, 201);
};

const updatePlace: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UpdatePlaceBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const place = await TravelSetup.of(caller).changePlace(routeParam(req, 'id'), body);
  const data: PlaceView = place.toView();
  res.success(data);
};

const removePlace: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  await TravelSetup.of(caller).removePlace(routeParam(req, 'id'));
  res.status(204).end();
};

// ─── Rules ──────────────────────────────────────────────────────────────────

const listRules: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const data: TravelRuleView[] = (await TravelRule.listOwn(caller)).map((rule) => rule.toView());
  res.success(data);
};

const createRule: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(CreateRuleBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const data: TravelRuleView = (await TravelSetup.of(caller).addRule(body)).toView();
  res.success(data, 201);
};

const updateRule: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UpdateRuleBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const rule = await TravelSetup.of(caller).changeRule(routeParam(req, 'id'), body);
  const data: TravelRuleView = rule.toView();
  res.success(data);
};

const removeRule: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  await TravelSetup.of(caller).removeRule(routeParam(req, 'id'));
  res.status(204).end();
};

// ─── Settings, default places and pins ──────────────────────────────────────

const getSettings: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const data: TravelSettingsResponse = await TravelSetup.of(caller).settings();
  res.success(data);
};

const updateSettings: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(UpdateSettingsBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const data: TravelSettingsResponse = await TravelSetup.of(caller).changeSettings(body);
  res.success(data);
};

const setContainerPlace: RequestHandler = async (req, res): Promise<void> => {
  const { placeId } = parseOr400(PlacePinBody, req.body);
  const { caller } = req as WorkspaceRequest;
  await TravelSetup.of(caller).setContainerPlace(routeParam(req, 'containerId'), placeId);
  res.status(204).end();
};

const pinItemPlace: RequestHandler = async (req, res): Promise<void> => {
  const { placeId } = parseOr400(PlacePinBody, req.body);
  const { caller } = req as WorkspaceRequest;
  await TravelSetup.of(caller).pinItemPlace(routeParam(req, 'itemId'), placeId);
  res.status(204).end();
};

// ─── Marking an item, and the preview ───────────────────────────────────────

const markItem: RequestHandler = async (req, res): Promise<void> => {
  const { occurrence, every, ...body } = parseOr400(MarkItemBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const { rule, legs, within, lengthStored } = await TravelRule.markItem(caller, {
    ...body,
    itemId: routeParam(req, 'itemId'),
    occurrence: optionalTime(occurrence),
    every: every ?? false,
  });
  const reads = await ItemQuery.for(caller);
  const data: MarkItemResponse = {
    rule: rule.toView(),
    legs: await Promise.all(legs.map((leg) => reads.detail(leg))),
    within,
    lengthStored,
  };
  res.success(data);
};

const unmarkItem: RequestHandler = async (req, res): Promise<void> => {
  const { occurrence, every } = parseOr400(UnmarkItemQuery, req.query);
  const { caller } = req as WorkspaceRequest;
  await TravelRule.unmarkItem(caller, {
    itemId: routeParam(req, 'itemId'),
    occurrence: optionalTime(occurrence),
    every: every === 'true',
  });
  res.status(204).end();
};

const preview: RequestHandler = async (req, res): Promise<void> => {
  const { arriveBy, departAt, ...body } = parseOr400(PreviewBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const data: TravelPreviewResponse = await TravelPlanner.preview(caller, {
    ...body,
    arriveBy: optionalTime(arriveBy),
    departAt: optionalTime(departAt),
  });
  res.success(data);
};

// ─── Legs and days ──────────────────────────────────────────────────────────

const editLeg: RequestHandler = async (req, res): Promise<void> => {
  const { startAt, endAt, minutes } = parseOr400(LegEditBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const edited = await TravelSetup.of(caller).editLeg(routeParam(req, 'id'), {
    startAt: optionalTime(startAt),
    endAt: optionalTime(endAt),
    minutes,
  });
  const data: ItemDetail = await (await ItemQuery.for(caller)).detail(edited);
  res.success(data);
};

const changeLegMode: RequestHandler = async (req, res): Promise<void> => {
  const { mode, scope } = parseOr400(LegModeBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const { marked, leg } = await TravelSetup.of(caller).changeLegMode(routeParam(req, 'id'), {
    mode,
    scope,
  });
  const reads = await ItemQuery.for(caller);
  const data: LegModeResponse = { marked, leg: leg === null ? null : await reads.detail(leg) };
  res.success(data);
};

const skipLeg: RequestHandler = async (req, res): Promise<void> => {
  parseOr400(EmptyBody, req.body);
  const { caller } = req as WorkspaceRequest;
  await (await TravelLeg.findOwn(caller, routeParam(req, 'id'))).skip(caller);
  res.status(204).end();
};

const resetLeg: RequestHandler = async (req, res): Promise<void> => {
  parseOr400(EmptyBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const leg = await TravelSetup.of(caller).resetLeg(routeParam(req, 'id'));
  const data: ItemDetail = await (await ItemQuery.for(caller)).detail(leg);
  res.success(data);
};

const legLinks: RequestHandler = async (req, res): Promise<void> => {
  const { caller } = req as WorkspaceRequest;
  const leg = await TravelLeg.findOwn(caller, routeParam(req, 'id'));
  const data: TravelLinksResponse = { links: await leg.links(caller) };
  res.success(data);
};

const days: RequestHandler = async (req, res): Promise<void> => {
  const { from, to } = parseOr400(DaysQuery, req.query);
  const { caller } = req as WorkspaceRequest;
  const data: TravelDaysResponse = await TravelLeg.days(caller, from, to);
  res.success(data);
};

export const TravelController = {
  listPlaces,
  createPlace,
  updatePlace,
  removePlace,
  listRules,
  createRule,
  updateRule,
  removeRule,
  getSettings,
  updateSettings,
  setContainerPlace,
  pinItemPlace,
  markItem,
  unmarkItem,
  preview,
  editLeg,
  changeLegMode,
  skipLeg,
  resetLeg,
  legLinks,
  days,
} as const;
