import { z } from 'zod';

import { TravelSetup } from '../../../classes/travel/index.js';
import { UpdateSettingsBody } from '../../../services/travelSchemas.js';
import { defineTool } from '../../tool.js';
import { itemCaller } from '../itemViews.js';
import { PRIVACY_NOTE, SettingsViewSchema } from './travelViews.js';

export const travelGetSettings = defineTool({
  name: 'travel_get_settings',
  title: 'Get the member’s travel settings',
  description: `The key’s own member’s travel settings: going home in a long enough window between two events at one place, and the mode a new rule starts on (the spec’s defaults until changed); and the default places of calendars and projects, by id. Trip lengths are not settings: the member sets each trip’s minutes once (travel_edit_leg or travel_mark_item with minutes) and every repeat of that trip uses them. ${PRIVACY_NOTE}`,
  toolset: 'items',
  inputSchema: z.strictObject({}),
  outputSchema: SettingsViewSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['read'],
  minRole: 'editor',
  async handler(ctx) {
    return {
      output: await TravelSetup.of(itemCaller(ctx)).settings(),
      target: { type: 'workspace', id: ctx.workspace.id },
    };
  },
});

export const travelSetSettings = defineTool({
  name: 'travel_set_settings',
  title: 'Change the member’s travel settings',
  description: `Changes any part of the member’s travel settings (what is left out stays): goHome (enabled, minWindowMinutes at least 180, minAtHomeMinutes at least 60) and defaultMode (walk, drive or transit). Checked whole: a value out of range is an error and nothing changes. The member’s legs are made again before it answers. ${PRIVACY_NOTE}`,
  toolset: 'items',
  inputSchema: UpdateSettingsBody,
  outputSchema: SettingsViewSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['items:write'],
  minRole: 'editor',
  async handler(ctx, input) {
    return {
      output: await TravelSetup.of(itemCaller(ctx)).changeSettings(input),
      target: { type: 'workspace', id: ctx.workspace.id },
    };
  },
});
