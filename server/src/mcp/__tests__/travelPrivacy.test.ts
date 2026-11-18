/**
 * Travel privacy over MCP (the travel spec, "Privacy and safety"): an agent sees a place by its
 * name only, never an address or a coordinate, in any answer; and a key is its member's alone.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { insertAgentKey } from './helpers/agentKeys.js';
import { errorText, startMcpHarness, structured, type McpHarness } from './helpers/mcpHarness.js';
import { newTeam, type Team } from './helpers/team.js';

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
});
