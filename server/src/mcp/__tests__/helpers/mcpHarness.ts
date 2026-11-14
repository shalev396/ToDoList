/**
 * Test-only: the API (createApp, or an app a test builds) on an ephemeral port over a throwaway
 * MongoDB, run as the dev stage with the test seams in place (testing/testSeams.ts), plus MCP
 * clients that talk to it over real HTTP with the SDK client. Every response body the clients receive is recorded, so a test can assert
 * on the raw bytes that reached the client.
 *
 * config/environment.ts reads process.env once, at import: start the harness before importing
 * anything that reads it, and import those modules dynamically afterwards.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { setRateLimitsOffForTests } from '../../../config/testSwitches.js';
import { startMemoryMongo } from '../../../testing/memoryMongo.js';
import { installTestSeams, TEST_STAGE_ENV, type TestSeams } from '../../../testing/testSeams.js';

export interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

export interface McpConnectOptions {
  /** /api/mcp/readonly instead of /api/mcp. */
  readonly?: boolean;
  /** The 2026-07-28 revision (server/discover, per-request envelope) instead of the 2025 handshake. */
  modern?: boolean;
}

export interface McpHarness {
  base: string;
  /** The seams in place: the emails the app sent, the in-memory bucket. */
  seams: TestSeams;
  /** An SDK client connected with this key. */
  connect(key: string, options?: McpConnectOptions): Promise<Client>;
  /** One raw POST (no SDK): for status codes, headers and exact bodies. */
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<RawResponse>;
  /** Every response body the SDK clients received, in order. */
  received(): string[];
  stop(): Promise<void>;
}

export interface McpHarnessOptions {
  /** Extra environment. */
  env?: Record<string, string>;
  /** Keep the in-app rate limits on (they are off in tests by default). */
  rateLimits?: boolean;
  /** The app to serve; default: createApp(). Called after the database is up. */
  app?: () => Promise<Express>;
}

/** Headers a 2025-era client sends on every POST. */
export const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

export async function startMcpHarness(
  dbName: string,
  options: McpHarnessOptions = {},
): Promise<McpHarness> {
  const mongo = await startMemoryMongo(dbName);
  Object.assign(process.env, { ...TEST_STAGE_ENV, DATABASE_URL: mongo.uri, ...options.env });
  const seams = await installTestSeams();
  setRateLimitsOffForTests(options.rateLimits !== true);
  const { initDB, syncDB } = await import('../../../config/database.js');
  await initDB();
  await syncDB();
  const app = options.app ? await options.app() : (await import('../../../app.js')).createApp();
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  const bodies: string[] = [];
  const recordingFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const response = await fetch(url, init);
    bodies.push(await response.clone().text());
    return response;
  };
  const clients: Client[] = [];

  return {
    base,
    seams,
    async connect(key, connectOptions = {}): Promise<Client> {
      const path = connectOptions.readonly === true ? '/api/mcp/readonly' : '/api/mcp';
      const transport = new StreamableHTTPClientTransport(new URL(`${base}${path}`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
        fetch: recordingFetch,
      });
      const client = new Client(
        { name: 'todolist-mcp-test', version: '1.0.0' },
        connectOptions.modern === true
          ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
          : {},
      );
      await client.connect(transport);
      clients.push(client);
      return client;
    },
    async post(path, body, headers = MCP_HEADERS): Promise<RawResponse> {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: response.status, headers: response.headers, text: await response.text() };
    },
    received: () => [...bodies],
    async stop(): Promise<void> {
      await Promise.allSettled(clients.map((client) => client.close()));
      server.close();
      const mongoose = (await import('mongoose')).default;
      await mongoose.disconnect();
      await mongo.stop();
    },
  };
}

/** The structured result of a tool call; callers cast it to the shape they assert on. */
export function structured(result: { structuredContent?: unknown }): unknown {
  return result.structuredContent;
}

/** The text of an isError result. */
export function errorText(result: { isError?: unknown; content?: unknown }): string {
  const [first] = (result.content ?? []) as { type: string; text?: string }[];
  return first?.text ?? '';
}
