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
  description: `Saves a place the member travels to or from (a new one needs a name, and lat and lon or an address that is looked up; a "lat, lon" address needs no lookup), or changes one (give its id; anything left out stays). aliases are other names rules and marks may use ("ORT Braude", "בראודה"). home: true makes it the member’s one Home (the old one becomes a plain place). The member’s legs are made again before it answers. Up to 30 places. A lookup that finds nothing is an error (place_not_found); one that can’t reach a geocoder is too (provider_unreachable): nothing is stored. ${PRIVACY_NOTE}`,
  toolset: 'items',
  inputSchema: z.strictObject({
    id: PlaceId.optional().describe('Change this place; left out: a new place'),
    name: z.string().max(200).optional(),
    address: z.string().max(1000).optional().describe('Looked up unless lat and lon are given'),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    aliases: z.array(z.string().max(200)).max(20).optional(),
    home: z.boolean().optional(),
  }),
  outputSchema: z.object({ place: PlaceAgentViewSchema }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  scopes: ['items:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    const { id, name, lat, lon, ...rest } = input;
    if ((lat === undefined) !== (lon === undefined)) {
      throw new ValidationError('lat: give lat and lon together');
    }
    const coords = lat === undefined || lon === undefined ? undefined : { lat, lon };
    const setup = TravelSetup.of(itemCaller(ctx));
    let place: Place;
    if (id !== undefined) {
      place = await setup.changePlace(id, { ...rest, name, coords });
    } else {
      if (name === undefined) throw new ValidationError('name: Required for a new place');
      place = await setup.addPlace({ ...rest, name, coords });
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
