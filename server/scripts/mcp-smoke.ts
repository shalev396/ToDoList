/**
 * npm run mcp:smoke
 *
 * Connects to a TodoList MCP server as an agent and runs the plugin's happy path: tools/list,
 * list_today, search_items, create_todo twice with one idempotencyKey (the same item must come
 * back), and builder_preview on the main dashboard. Prints a pass/fail table, never the key.
 *
 *   TODOLIST_AGENT_KEY=elk_…  TODOLIST_MCP_URL=http://127.0.0.1:3207/api/mcp  npm run mcp:smoke
 *
 * The key needs scopes read and items:write; tools/list only shows the tools the key may call,
 * so the expected names are the read, items and builder_preview ones. The to-do it creates is titled "Smoke test …" and is
 * left open: complete or delete it in the app.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export const EXPECTED_TOOLS = [
  'search_items',
  'list_today',
  'list_deadlines',
  'get_calendar',
  'get_item',
  'create_todo',
  'update_todo',
  'complete_todo',
  'delete_todo',
  'builder_list_dashboards',
  'builder_preview',
] as const;

export interface SmokeStep {
  name: string;
  ok: boolean;
  detail: string;
}

type Args = Record<string, unknown>;

interface Callable {
  listTools(): Promise<{ tools: { name: string }[] }>;
  callTool(params: { name: string; arguments: Args }): Promise<{
    isError?: boolean | undefined;
    structuredContent?: unknown;
    content?: unknown;
  }>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/** Runs the flow against a connected client. Never throws: a failed step is a row. */
export async function runSmoke(client: Callable): Promise<SmokeStep[]> {
  const steps: SmokeStep[] = [];
  const step = async (name: string, run: () => Promise<string>): Promise<void> => {
    try {
      steps.push({ name, ok: true, detail: await run() });
    } catch (error) {
      steps.push({ name, ok: false, detail: message(error) });
    }
  };
  const call = async (name: string, args: Args = {}): Promise<Record<string, unknown>> => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError === true) {
      const [first] = (result.content ?? []) as { text?: string }[];
      throw new Error(`${name} failed: ${(first?.text ?? 'no message').slice(0, 160)}`);
    }
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  };

  await step('tools/list', async () => {
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
    const missing = EXPECTED_TOOLS.filter((name) => !names.has(name));
    if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`);
    return `${String(names.size)} tools`;
  });

  await step('list_today', async () => {
    await call('list_today');
    return 'ok';
  });

  await step('search_items', async () => {
    const { items } = await call('search_items', { q: 'smoke', limit: 5 });
    if (!Array.isArray(items)) throw new Error('no items array');
    return `${String(items.length)} items`;
  });

  await step('create_todo twice (idempotencyKey)', async () => {
    const args = {
      title: `Smoke test ${new Date().toISOString().slice(0, 10)}: check the plugin`,
      // A topic by its slug: every workspace starts with Personal.
      topic: 'personal',
      dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      idempotencyKey: `smoke-${randomUUID()}`,
    };
    const first = await call('create_todo', args);
    const second = await call('create_todo', args);
    const id = (first['item'] as { id?: string } | undefined)?.id;
    const again = (second['item'] as { id?: string } | undefined)?.id;
    if (id === undefined || id !== again) throw new Error('the retry made a different item');
    if (first['created'] !== true || second['created'] !== false)
      throw new Error('created flags are wrong (expected true, then false)');
    return 'same item on retry';
  });

  await step('builder_preview (main dashboard)', async () => {
    const { dashboards } = await call('builder_list_dashboards');
    const all = (Array.isArray(dashboards) ? dashboards : []) as {
      id: string;
      scope?: { topicId: string | null };
    }[];
    // The main dashboard has no topic; a fresh workspace starts with its first page only.
    const main = all.find((d) => d.scope?.topicId === null) ?? all[0];
    if (main === undefined) throw new Error('no main dashboard');
    const preview = await call('builder_preview', { dashboardId: main.id });
    if (preview['valid'] !== true) throw new Error('the draft does not validate');
    return 'draft valid';
  });

  return steps;
}

export function formatTable(steps: readonly SmokeStep[]): string {
  const width = Math.max(...steps.map((s) => s.name.length));
  return steps
    .map((s) => `${s.ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(width)}  ${s.detail}`)
    .join('\n');
}

async function main(): Promise<void> {
  const key = process.env['TODOLIST_AGENT_KEY'];
  const url = process.env['TODOLIST_MCP_URL'];
  if (key === undefined || key === '' || url === undefined || url === '') {
    console.error('Set TODOLIST_AGENT_KEY (an elk_ key) and TODOLIST_MCP_URL (…/api/mcp).');
    process.exit(2);
  }
  const client = new Client({ name: 'todolist-mcp-smoke', version: '1.0.0' });
  let steps: SmokeStep[];
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    steps = await runSmoke(client);
    await client.close();
  } catch (error) {
    steps = [{ name: 'connect', ok: false, detail: message(error).replaceAll(key, '[key]') }];
  }
  process.stdout.write(`${formatTable(steps)}
`);
  process.exit(steps.every((s) => s.ok) ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
