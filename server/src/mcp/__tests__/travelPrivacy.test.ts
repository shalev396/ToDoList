/**
 * Travel privacy over MCP (the travel spec, "Privacy and safety"): an agent sees a place by its
 * name only, never an address or a coordinate, in any answer; and a key is its member's alone:
 * another member's key never sees their legs, on any path that lists time (get_calendar,
 * list_today's scheduled, search_items by kind).
 */
import { wallDate } from '../../types/recurrence/zoned.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { insertAgentKey } from './helpers/agentKeys.js';
import { errorText, startMcpHarness, structured, type McpHarness } from './helpers/mcpHarness.js';
import { newTeam, type Team } from './helpers/team.js';

/** An entry of a tool's list, as far as these checks read it. */
interface Entry {
  id: string;
  kind: string;
}

let h: McpHarness;
let team: Team;
let keyA: string;
let keyB: string;

const ADDRESS = 'Snunit St 51, Karmiel';
const SECRETS = [ADDRESS, '32.9141', '35.2922'];

function at(days: number, hour: number): Date {
  const day = new Date(Date.now() + days * 86_400_000);
  day.setUTCHours(hour, 0, 0, 0);
  return day;
}

before(async () => {
  h = await startMcpHarness('todolist_mcp_travel_privacy_test', {});
  team = await newTeam('travel-privacy');
  const { newUser } = await import('../../testing/workspaceFixtures.js');
  const { getMembershipRepository } = await import('../../models/index.js');
  const second = await newUser('travel-privacy-b');
  await (
    await getMembershipRepository()
  ).create(team.workspace.id, { userId: second.id, role: 'editor' });
  const scopes = ['read', 'items:write'] as ('read' | 'items:write')[];
  keyA = (await insertAgentKey({ workspaceId: team.workspace.id, userId: team.editor.id, scopes }))
    .raw;
  keyB = (await insertAgentKey({ workspaceId: team.workspace.id, userId: second.id, scopes })).raw;
});

after(async () => {
  await h.stop();
});

describe('travel privacy over MCP', () => {
  it('no tool output carries an address or coordinates', async () => {
    const client = await h.connect(keyA);
    const outputs: string[] = [];
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name}: ${errorText(result)}`);
      outputs.push(JSON.stringify(result));
      return structured(result);
    };

    // The address and the coordinates go in; neither comes back.
    await call('travel_set_place', {
      name: 'Home',
      address: ADDRESS,
      lat: 32.9141,
      lon: 35.2922,
      home: true,
    });
    await call('travel_set_place', { name: 'Campus', lat: 32.7767, lon: 35.0231 });
    await call('travel_list_places', {});
    const todo = (await call('create_todo', {
      title: 'Lecture',
      startAt: at(3, 10).toISOString(),
      endAt: at(3, 12).toISOString(),
    })) as { item: { id: string } };
    await call('travel_set_rule', {
      itemId: todo.item.id,
      mode: 'transit',
      direction: 'both',
      place: 'Campus',
    });
    await call('travel_list_rules', {});
    await call('travel_get_settings', {});
    await call('travel_set_settings', { buffers: { transit: 7 } });
    const marked = (await call('travel_mark_item', {
      itemId: todo.item.id,
      mode: 'transit',
      direction: 'both',
      place: 'Campus',
    })) as { legs: { id: string }[] };
    assert.ok(marked.legs.length > 0);
    const legId = marked.legs[0]?.id ?? '';
    await call('travel_edit_leg', { legId, minutes: 20 });
    await call('get_item', { id: legId });
    await call('get_calendar', {
      range: 'custom',
      from: at(0, 0).toISOString(),
      to: at(14, 0).toISOString(),
    });
    await call('list_today', {});
    await call('search_items', { kind: ['travel'] });
    await call('travel_reset_leg', { legId });
    await call('travel_skip_leg', { legId });

    assert.ok(outputs.length > 10);
    for (const output of [...outputs, ...h.received()]) {
      // What went in as a request is not an answer: the harness records only responses.
      for (const secret of SECRETS) {
        assert.ok(!output.includes(secret), `an answer carries ${secret}`);
      }
    }
  });

  it("B's key lists no places of A and cannot get A's leg", async () => {
    const a = await h.connect(keyA);
    const b = await h.connect(keyB);
    const { places } = structured(
      await a.callTool({ name: 'travel_list_places', arguments: {} }),
    ) as { places: { id: string }[] };
    assert.ok(places.length >= 2);
    const aLegs = structured(
      await a.callTool({ name: 'search_items', arguments: { kind: ['travel'] } }),
    ) as { items: { id: string }[] };
    assert.ok(aLegs.items.length > 0);

    const bPlaces = structured(await b.callTool({ name: 'travel_list_places', arguments: {} })) as {
      places: unknown[];
    };
    assert.deepEqual(bPlaces.places, []);
    const bRules = structured(await b.callTool({ name: 'travel_list_rules', arguments: {} })) as {
      rules: unknown[];
    };
    assert.deepEqual(bRules.rules, []);

    for (const leg of aLegs.items) {
      const got = await b.callTool({ name: 'get_item', arguments: { id: leg.id } });
      assert.equal(got.isError, true);
      for (const name of ['travel_edit_leg', 'travel_skip_leg', 'travel_reset_leg']) {
        const result = await b.callTool({
          name,
          arguments: { legId: leg.id, ...(name === 'travel_edit_leg' ? { minutes: 5 } : {}) },
        });
        assert.equal(result.isError, true, name);
      }
    }
    for (const place of places) {
      const result = await b.callTool({
        name: 'travel_remove_place',
        arguments: { id: place.id, confirm: true },
      });
      assert.equal(result.isError, true);
    }
    // B asks to travel to A's place by name: no such place of B's.
    const todo = structured(
      await b.callTool({
        name: 'create_todo',
        arguments: {
          title: 'B lecture',
          startAt: at(4, 10).toISOString(),
          endAt: at(4, 11).toISOString(),
        },
      }),
    ) as { item: { id: string } };
    const refused = await b.callTool({
      name: 'travel_mark_item',
      arguments: { itemId: todo.item.id, mode: 'walk', direction: 'there', place: 'Campus' },
    });
    assert.equal(refused.isError, true);
    // A still has everything.
    const still = structured(await a.callTool({ name: 'travel_list_places', arguments: {} })) as {
      places: unknown[];
    };
    assert.equal(still.places.length, places.length);
  });

  it("B's calendar, today and search never show A's legs", async () => {
    const a = await h.connect(keyA);
    const b = await h.connect(keyB);
    const call = async (
      client: typeof a,
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name}: ${errorText(result)}`);
      return structured(result);
    };
    const travel = (entries: readonly Entry[]): Entry[] =>
      entries.filter((entry) => entry.kind === 'travel');

    // A coffee a short walk from A's Home, two hours from now: its legs are today unless today is
    // nearly over in the workspace's zone.
    await call(a, 'travel_set_place', { name: 'Cafe', lat: 32.915, lon: 35.293 });
    const start = new Date(Date.now() + 2 * 3_600_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    const coffee = (await call(a, 'create_todo', {
      title: 'Coffee',
      startAt: start.toISOString(),
      endAt: end.toISOString(),
    })) as { item: { id: string } };
    const marked = (await call(a, 'travel_mark_item', {
      itemId: coffee.item.id,
      mode: 'walk',
      direction: 'both',
      place: 'Cafe',
    })) as { legs: { id: string }[] };
    assert.ok(marked.legs.length > 0);

    const range = {
      range: 'custom',
      from: new Date().toISOString(),
      to: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    };
    const aCalendar = (await call(a, 'get_calendar', range)) as { items: Entry[] };
    const aLegIds = new Set(travel(aCalendar.items).map((entry) => entry.id));
    // A sees their own legs (the coffee's and the lecture's left from the first test).
    assert.ok(aLegIds.size >= 2, `A's calendar holds ${String(aLegIds.size)} legs`);
    const aSearch = (await call(a, 'search_items', { kind: ['travel'] })) as { items: Entry[] };
    assert.ok(aSearch.items.length >= 2);

    // B: none of them, on any path.
    const bCalendar = (await call(b, 'get_calendar', range)) as { items: Entry[] };
    assert.deepEqual(travel(bCalendar.items), []);
    assert.ok(bCalendar.items.every((entry) => !aLegIds.has(entry.id)));
    const bToday = (await call(b, 'list_today', {})) as {
      timezone: string;
      scheduled: Entry[];
      events: Entry[];
    };
    assert.deepEqual(travel(bToday.scheduled), []);
    assert.ok([...bToday.scheduled, ...bToday.events].every((entry) => !aLegIds.has(entry.id)));
    const bSearch = (await call(b, 'search_items', { kind: ['travel'] })) as { items: Entry[] };
    assert.deepEqual(bSearch.items, []);
    const bSearchAll = (await call(b, 'search_items', { q: 'Walk' })) as { items: Entry[] };
    assert.ok(bSearchAll.items.every((entry) => entry.kind !== 'travel' && !aLegIds.has(entry.id)));

    // The control: when the coffee is today, A's own today lists its legs, so B's empty list is
    // the privacy rule and not an empty day.
    const aToday = (await call(a, 'list_today', {})) as { timezone: string; scheduled: Entry[] };
    if (wallDate(end, aToday.timezone) === wallDate(new Date(), aToday.timezone)) {
      assert.ok(travel(aToday.scheduled).length > 0, "A's today lists A's legs");
    }
  });
});
