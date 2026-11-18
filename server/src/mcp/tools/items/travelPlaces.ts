import { z } from 'zod';

import { Place, TravelSetup } from '../../../classes/travel/index.js';
import { ValidationError } from '../../../errors/ValidationError.js';
import { confirmField } from '../../middleware/confirm.js';
import { defineTool } from '../../tool.js';
import { itemCaller } from '../itemViews.js';
import { PlaceAgentViewSchema, PRIVACY_NOTE } from './travelViews.js';

const PlaceId = z.string().min(1).max(100).describe('A place id, as travel_list_places lists it');

export const travelListPlaces = defineTool({
  name: 'travel_list_places',
  title: 'List the member’s travel places',
  description: `The key’s own member’s saved places (Home, campus, the gym), oldest first: id, name, aliases and whether it is Home. Another member’s places are never listed. ${PRIVACY_NOTE}`,
  toolset: 'items',
  inputSchema: z.strictObject({}),
  outputSchema: z.object({ places: z.array(PlaceAgentViewSchema) }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['read'],
  minRole: 'editor',
  async handler(ctx) {
    const places = await Place.listOwn(itemCaller(ctx));
    return {
      output: { places: places.map((place) => place.toAgentView()) },
      target: { type: 'workspace', id: ctx.workspace.id },
    };
  },
});

export const travelSetPlace = defineTool({
  name: 'travel_set_place',
  title: 'Save or change a travel place',
  description: `Saves a place the member travels to or from (a new one needs a name), or changes one (give its id; anything left out stays). address is optional free text, never looked up: it only opens Waze or Google Maps on the member’s own device (a typed "lat, lon" is just text). aliases are other names rules, marks and event locations may use ("ORT Braude", "בראודה"). home: true makes it the member’s one Home (the old one becomes a plain place). The member’s legs are made again before it answers. Up to 30 places. ${PRIVACY_NOTE}`,
  toolset: 'items',
  inputSchema: z.strictObject({
    id: PlaceId.optional().describe('Change this place; left out: a new place'),
    name: z.string().max(200).optional(),
    address: z
      .string()
      .max(1000)
      .optional()
      .describe('Free text for map links only, never looked up; empty clears it'),
    aliases: z.array(z.string().max(200)).max(20).optional(),
    home: z.boolean().optional(),
  }),
  outputSchema: z.object({ place: PlaceAgentViewSchema }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  scopes: ['items:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const { id, name, ...rest } = input;
    const setup = TravelSetup.of(itemCaller(ctx));
    let place: Place;
    if (id !== undefined) {
      place = await setup.changePlace(id, { ...rest, name });
    } else {
      if (name === undefined) throw new ValidationError('name: Required for a new place');
      place = await setup.addPlace({ ...rest, name });
    }
    return { output: { place: place.toAgentView() }, target: { type: 'place', id: place.id } };
  },
});

export const travelRemovePlace = defineTool({
  name: 'travel_remove_place',
  title: 'Remove a travel place',
  description: `Removes one of the member’s places, with everything of theirs that points at it: rules naming it name none and pins to it go. Without Home there are no legs. Without confirm: true it only previews and changes nothing. ${PRIVACY_NOTE}`,
  toolset: 'items',
  inputSchema: z.strictObject({ id: PlaceId, confirm: confirmField }),
  outputSchema: z.object({
    applied: z.boolean().describe('false: a preview, nothing changed'),
    place: PlaceAgentViewSchema,
    summary: z.string(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  scopes: ['items:write'],
  minRole: 'editor',
  async preview(ctx, input) {
    const place = await Place.findOwn(itemCaller(ctx), input.id);
    return {
      output: {
        applied: false,
        place: place.toAgentView(),
        summary:
          'Preview: this place would be removed, with the rules and pins that point at it. Nothing changed; call again with confirm: true.',
      },
      target: { type: 'place', id: place.id },
    };
  },
  async handler(ctx, input) {
    const caller = itemCaller(ctx);
    const place = await Place.findOwn(caller, input.id);
    await TravelSetup.of(caller).removePlace(place.id);
    return {
      output: { applied: true, place: place.toAgentView(), summary: 'The place was removed.' },
      target: { type: 'place', id: place.id },
    };
  },
});
