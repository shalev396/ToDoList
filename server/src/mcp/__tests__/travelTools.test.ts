/**
 * The travel tools over MCP (docs/superpowers/specs/2026-11-17-travel-time-design.md, "MCP"): the
 * key's own member sets their places and rules, marks an item or a series, and reads the legs
 * through get_calendar as busy time. Places are named by their name; a removal needs confirm.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { insertAgentKey } from './helpers/agentKeys.js';
import { errorText, startMcpHarness, structured, type McpHarness } from './helpers/mcpHarness.js';
import { newTeam, type Team } from './helpers/team.js';

let h: McpHarness;
let team: Team;
let key: string;

/** `days` days from now at the given UTC hour. */
function at(days: number, hour: number): Date {
  const day = new Date(Date.now() + days * 86_400_000);
  day.setUTCHours(hour, 0, 0, 0);
  return day;
}

interface PlaceOut {
  id: string;
  name: string;
  aliases: string[];
  home: boolean;
}
interface Entry {
  id: string;
  kind: string;
  title: string;
  busy?: boolean;
  startAt: string | null;
  endAt: string | null;
  props: {
    travel?: { minutes: number; source: string; lengthUnset: boolean; edited: boolean };
  };
}

before(async () => {
  h = await startMcpHarness('todolist_mcp_travel_tools_test', {});
  team = await newTeam('travel-tools');
  key = (
    await insertAgentKey({
      workspaceId: team.workspace.id,
      userId: team.editor.id,
      scopes: ['read', 'items:write'],
    })
  ).raw;
});

after(async () => {
  await h.stop();
});

describe('the travel tools', () => {
  it('set Home with an address, a rule on a calendar, mark a series → legs listed by get_calendar as busy', async () => {
    const client = await h.connect(key);
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name}: ${errorText(result)}`);
      return structured(result);
    };

    const home = (await call('travel_set_place', {
      name: 'Home',
      address: 'Herzl 1, Haifa',
      home: true,
    })) as { place: PlaceOut };
    assert.equal(home.place.home, true);
    assert.deepEqual(Object.keys(home.place).sort(), ['aliases', 'home', 'id', 'name']);
    await call('travel_set_place', { name: 'Technion', aliases: ['הטכניון'] });
    // Coordinates are no input any more: a place is a name and an address.
    const client2 = await h.connect(key);
    const withCoords = await client2.callTool({
      name: 'travel_set_place',
      arguments: { name: 'Gym', lat: 32.8, lon: 35.0 },
    });
    assert.equal(withCoords.isError, true);
    const listed = (await call('travel_list_places', {})) as { places: PlaceOut[] };
    assert.deepEqual(listed.places.map((place) => place.name).sort(), ['Home', 'Technion']);

    // A rule on a calendar: its items travel to the Technion (named by its alias).
    const rule = (await call('travel_set_rule', {
      where: {
        combinator: 'and',
        rules: [{ field: 'containerId', operator: '=', value: 'cal-technion' }],
      },
      mode: 'transit',
      direction: 'both',
      place: 'הטכניון',
    })) as { rule: { id: string; place: string | null } };
    assert.equal(rule.rule.place, 'Technion');
    const rules = (await call('travel_list_rules', {})) as { rules: { id: string }[] };
    assert.deepEqual(
      rules.rules.map((r) => r.id),
      [rule.rule.id],
    );
    const settings = (await call('travel_get_settings', {})) as {
      settings: { defaultMode: string };
    };
    assert.equal(settings.settings.defaultMode, 'transit');
    const changed = (await call('travel_set_settings', { defaultMode: 'walk' })) as typeof settings;
    assert.equal(changed.settings.defaultMode, 'walk');

    // A weekly lecture, marked as a series.
    const block = (await call('create_time_block', {
      title: 'Lecture',
      startAt: at(3, 10).toISOString(),
      endAt: at(3, 12).toISOString(),
      recurrence: ['RRULE:FREQ=WEEKLY'],
    })) as { item: { id: string } };
    const marked = (await call('travel_mark_item', {
      itemId: block.item.id,
      every: true,
      mode: 'transit',
      direction: 'both',
      place: 'technion',
    })) as { rule: { id: string }; legs: Entry[] };
    assert.ok(marked.legs.length >= 2, 'a leg there and a leg back');
    assert.ok(marked.legs.every((leg) => leg.kind === 'travel'));
    // No length set yet: every leg is drawn with the placeholder and says so.
    assert.ok(
      marked.legs.every(
        (leg) =>
          leg.props.travel?.lengthUnset === true &&
          leg.props.travel.source === 'unset' &&
          leg.props.travel.minutes === 30,
      ),
    );

    const calendar = (await call('get_calendar', {
      range: 'custom',
      from: at(0, 0).toISOString(),
      to: at(14, 0).toISOString(),
      kind: ['travel'],
    })) as { items: Entry[] };
    assert.ok(calendar.items.length >= 2);
    assert.ok(calendar.items.every((entry) => entry.kind === 'travel' && entry.busy === true));
  });

  it('minutes set the trip’s length once; travel_edit_leg minutes set it for every leg', async () => {
    const client = await h.connect(key);
    const todo = await client.callTool({
      name: 'create_todo',
      arguments: {
        title: 'Study group',
        startAt: at(5, 15).toISOString(),
        endAt: at(5, 16).toISOString(),
      },
    });
    assert.notEqual(todo.isError, true, errorText(todo));
    const { item } = structured(todo) as { item: { id: string; startAt: string | null } };
    assert.equal(item.startAt, at(5, 15).toISOString());
    const marked = await client.callTool({
      name: 'travel_mark_item',
      arguments: {
        itemId: item.id,
        mode: 'drive',
        direction: 'there',
        place: 'Technion',
        minutes: 25,
      },
    });
    assert.notEqual(marked.isError, true, errorText(marked));
    const { legs } = structured(marked) as { legs: Entry[] };
    assert.equal(legs.length, 1);
    const [leg] = legs;
    assert.ok(leg);
    // The trip's length, every time: not a hand edit.
    assert.deepEqual(
      { ...leg.props.travel },
      { ...leg.props.travel, minutes: 25, source: 'set', lengthUnset: false, edited: false },
    );

    const legId = leg.id;
    const edited = await client.callTool({
      name: 'travel_edit_leg',
      arguments: { legId, minutes: 30 },
    });
    assert.notEqual(edited.isError, true, errorText(edited));
    const { leg: after } = structured(edited) as { leg: Entry };
    assert.deepEqual(
      { ...after.props.travel },
      { ...after.props.travel, minutes: 30, source: 'set', edited: false },
    );
    assert.equal(after.endAt, at(5, 15).toISOString());
    for (const [name, args] of [
      ['travel_edit_leg', { legId, startAt: at(5, 13).toISOString() }],
      ['travel_reset_leg', { legId }],
      ['travel_skip_leg', { legId }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name}: ${errorText(result)}`);
    }
  });

  it('travel_mark_item marks an area: legs there and back are busy, the area itself is not', async () => {
    const client = await h.connect(key);
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name}: ${errorText(result)}`);
      return structured(result);
    };
    const area = (await call('create_time_block', {
      layer: 'area',
      title: 'Studying',
      startAt: at(6, 6).toISOString(),
      endAt: at(6, 14).toISOString(),
    })) as { item: { id: string } };
    const marked = (await call('travel_mark_item', {
      itemId: area.item.id,
      mode: 'transit',
      direction: 'both',
      place: 'Technion',
    })) as { rule: { scope: unknown }; legs: Entry[]; within: unknown };
    assert.deepEqual(marked.rule.scope, {
      kind: 'item',
      itemId: area.item.id,
      occurrence: 'single',
    });
    assert.deepEqual(
      marked.legs.map((leg) => [leg.kind, leg.title]),
      [
        ['travel', 'Bus to Technion'],
        ['travel', 'Bus home'],
      ],
    );
    assert.equal(marked.legs[0]?.endAt, at(6, 6).toISOString());
    assert.equal(marked.legs[1]?.startAt, at(6, 14).toISOString());
    assert.equal(marked.within, null);

    // A block inside it with no place: the marked area lends it the Technion, so no trips of its
    // own, and the answer says where it is spent.
    const reading = (await call('create_time_block', {
      title: 'Reading',
      startAt: at(6, 8).toISOString(),
      endAt: at(6, 9).toISOString(),
    })) as { item: { id: string } };
    const inside = (await call('travel_mark_item', {
      itemId: reading.item.id,
      mode: 'walk',
      direction: 'both',
    })) as { legs: Entry[]; within: unknown };
    assert.deepEqual(inside.legs, []);
    assert.deepEqual(inside.within, { area: 'Studying', place: 'Technion' });

    const calendar = (await call('get_calendar', {
      range: 'custom',
      from: at(6, 0).toISOString(),
      to: at(7, 0).toISOString(),
      kind: ['block', 'travel'],
    })) as { items: Entry[] };
    assert.deepEqual(
      calendar.items.map((entry) => [entry.title, entry.kind, entry.busy]),
      [
        ['Bus to Technion', 'travel', true],
        ['Studying', 'block', false],
        ['Reading', 'block', true],
        ['Bus home', 'travel', true],
      ],
    );
  });

  it('refuses an unknown place name without listing the places', async () => {
    const client = await h.connect(key);
    const result = await client.callTool({
      name: 'travel_set_rule',
      arguments: { seriesItemId: 'x', mode: 'walk', direction: 'there', place: 'Atlantis' },
    });
    assert.equal(result.isError, true);
    assert.match(errorText(result), /place/);
    assert.doesNotMatch(errorText(result), /Technion|Home/);
  });

  it('remove needs confirm', async () => {
    const client = await h.connect(key);
    const list = async (): Promise<PlaceOut[]> =>
      (
        structured(await client.callTool({ name: 'travel_list_places', arguments: {} })) as {
          places: PlaceOut[];
        }
      ).places;
    const technion = (await list()).find((place) => place.name === 'Technion');
    assert.ok(technion);
    const preview = await client.callTool({
      name: 'travel_remove_place',
      arguments: { id: technion.id },
    });
    assert.notEqual(preview.isError, true, errorText(preview));
    assert.equal((structured(preview) as { applied: boolean }).applied, false);
    assert.equal((await list()).length, 2);

    const done = await client.callTool({
      name: 'travel_remove_place',
      arguments: { id: technion.id, confirm: true },
    });
    assert.equal((structured(done) as { applied: boolean }).applied, true);
    assert.equal((await list()).length, 1);

    const rulesOf = async (): Promise<{ id: string }[]> =>
      (
        structured(await client.callTool({ name: 'travel_list_rules', arguments: {} })) as {
          rules: { id: string }[];
        }
      ).rules;
    const ruleId = (await rulesOf())[0]?.id ?? '';
    const rulePreview = await client.callTool({
      name: 'travel_remove_rule',
      arguments: { id: ruleId },
    });
    assert.equal((structured(rulePreview) as { applied: boolean }).applied, false);
    const before = (await rulesOf()).length;
    assert.ok(before >= 1);
    const removed = await client.callTool({
      name: 'travel_remove_rule',
      arguments: { id: ruleId, confirm: true },
    });
    assert.equal((structured(removed) as { applied: boolean }).applied, true);
    assert.equal((await rulesOf()).length, before - 1);
  });
});
