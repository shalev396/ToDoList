import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FixtureMissingError } from '../errors.js';
import { createReadOnlyClient } from '../http.js';
import { fixtureTransport, loadFixtureSet, type FixtureEntry } from './fixtures.js';

const ENTRIES: FixtureEntry[] = [
  {
    request: { url: 'https://api.example.com/repos/o/r/issues' },
    response: { body: { page: 'any' } },
  },
  {
    request: { url: 'https://api.example.com/repos/o/r/issues?page=2' },
    response: { body: { page: 2 } },
  },
  {
    request: { graphql: 'Board', variables: { number: 7 } },
    response: { body: { data: { board: 7 } } },
  },
  { request: { graphql: 'Board' }, response: { body: { data: { board: 'default' } } } },
];

describe('fixture transport', () => {
  it('matches REST requests by path and listed query params, most specific first', async () => {
    const transport = fixtureTransport(ENTRIES);
    const client = createReadOnlyClient({ provider: 'github', transport });
    const first = await client.getJson<{ page: unknown }>(
      'https://api.example.com/repos/o/r/issues?state=all&since=x',
    );
    const second = await client.getJson<{ page: unknown }>(
      'https://api.example.com/repos/o/r/issues?state=all&page=2',
    );
    assert.equal(first.data.page, 'any');
    assert.equal(second.data.page, 2);
  });

  it('a fixture for the placeholder site answers any other site (many-to-one in fixtures mode)', async () => {
    const transport = fixtureTransport([
      {
        request: { url: 'https://example.invalid/jira/rest/api/3/myself' },
        response: { body: { ok: true } },
      },
    ]);
    const client = createReadOnlyClient({ provider: 'jira', transport });
    for (const site of ['https://alpha.atlassian.net', 'https://example.invalid/jira']) {
      const got = await client.getJson<{ ok: boolean }>(`${site}/rest/api/3/myself`);
      assert.equal(got.data.ok, true);
    }
    await assert.rejects(
      client.getJson('https://alpha.atlassian.net/rest/api/3/other'),
      FixtureMissingError,
    );
  });

  it('matches GraphQL by operation name and listed variables', async () => {
    const transport = fixtureTransport(ENTRIES);
    const client = createReadOnlyClient({
      provider: 'github',
      transport,
      graphql: {
        endpoint: 'https://api.example.com/graphql',
        documents: { Board: 'query Board($number: Int) { b }' },
      },
    });
    assert.deepEqual(await client.graphql('Board', { number: 7, after: null }), { board: 7 });
    assert.deepEqual(await client.graphql('Board', { number: 9 }), { board: 'default' });
  });

  it('fails loudly, without the token, when no fixture matches', async () => {
    const transport = fixtureTransport(ENTRIES);
    await assert.rejects(
      transport.send({
        method: 'GET',
        url: 'https://moodle.example/rest?wstoken=FAKE999&f=1',
        headers: {},
      }),
      (error: unknown) => {
        assert.ok(error instanceof FixtureMissingError, 'a deterministic, never retried error');
        assert.match(error.message, /No fixture/);
        assert.equal(error.message.includes('FAKE999'), false);
        return true;
      },
    );
  });

  it('records every call for spying', async () => {
    const transport = fixtureTransport(ENTRIES);
    await transport.send({
      method: 'GET',
      url: 'https://api.example.com/repos/o/r/issues',
      headers: {},
    });
    assert.deepEqual(
      transport.calls.map((call) => call.method),
      ['GET'],
    );
  });

  it('loads every JSON file of a set, single entries and arrays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'todolist-fixtures-'));
    try {
      await writeFile(join(dir, 'a.json'), JSON.stringify(ENTRIES[0]));
      await writeFile(join(dir, 'b.json'), JSON.stringify(ENTRIES.slice(1)));
      await writeFile(join(dir, 'notes.txt'), 'ignored');
      assert.equal((await loadFixtureSet(dir)).length, 4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves relative-date tokens in response bodies', async () => {
    const transport = fixtureTransport(
      [
        {
          request: { url: 'https://api.example.com/d' },
          response: { body: { due: '{{date:+1d}}' } },
        },
      ],
      { now: new Date('2026-11-12T08:15:00.000Z'), timeZone: 'Asia/Jerusalem' },
    );
    const res = await transport.send({
      method: 'GET',
      url: 'https://api.example.com/d',
      headers: {},
    });
    assert.deepEqual(JSON.parse(res.body), { due: '2026-11-13' });
  });
});
