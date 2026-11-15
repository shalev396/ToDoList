/**
 * Test-only: an API on a throwaway MongoDB with one workspace, one owner and one Google Calendar
 * integration connected with Google OAuth (seeded directly: no grant is needed by the tests that
 * use it), read & write, whose calendar `primary` is the workspace's primary calendar. Start it
 * before importing anything that reads the environment.
 */
import { randomUUID } from 'node:crypto';

import type * as Models from '../models/index.js';
import type { ItemData } from '../models/index.js';
import { startApiHarness, type ApiHarness } from './apiHarness.js';

export interface GcalFixture {
  api: ApiHarness;
  models: typeof Models;
  token: string;
  userId: string;
  workspaceId: string;
  integrationId: string;
  /** An item due `days` from now. */
  item(
    title: string,
    days: number,
    extra?: Partial<Parameters<ItemsRepo['createLocal']>[1]>,
  ): Promise<ItemData>;
  /** Replaces the integration's config (merged over the defaults). */
  setConfig(config: Record<string, unknown>): Promise<void>;
  /** The workspace's primary calendar: a calendar of the integration, or (null) none. */
  setPrimary(calendarId: string | null): Promise<void>;
  stop(): Promise<void>;
}

type ItemsRepo = Awaited<ReturnType<typeof Models.getItemRepository>>;

export async function startGcalFixture(dbName: string): Promise<GcalFixture> {
  const api = await startApiHarness(dbName);
  const models = await import('../models/index.js');
  const login = await api.login('gcal-owner@example.test');
  const me = await api.call('GET', '/api/private/me', { token: login.token });
  const userId = (me.body?.['data'] as { id: string }).id;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Gcal', slug: `gcal-${randomUUID().slice(0, 8)}`, ownerId: userId });
  await (await models.getMembershipRepository()).create(workspace.id, { userId, role: 'owner' });
  const config = { calendars: [{ id: 'primary', mode: 'two_way' }] };
  const seeded = await (
    await models.getIntegrationRepository()
  ).create(workspace.id, {
    connectedBy: userId,
    provider: 'google_calendar',
    accountId: `pending:${randomUUID()}`,
    label: 'Google Calendar',
    authMethod: 'oauth',
    topicId: 'personal',
    mode: 'read_write',
    config,
    status: 'active',
    lastError: null,
  });
  const integrationId = seeded.id;
  const setPrimary = async (calendarId: string | null): Promise<void> => {
    await (
      await models.getWorkspaceRepository()
    ).setPrimaryCalendar(workspace.id, calendarId === null ? null : { integrationId, calendarId });
  };
  await setPrimary('primary');

  return {
    api,
    models,
    token: login.token,
    userId,
    workspaceId: workspace.id,
    integrationId,
    async item(title, days, extra = {}): Promise<ItemData> {
      return (await models.getItemRepository()).createLocal(workspace.id, {
        ownerUserId: userId,
        title,
        topicId: 'personal',
        dueAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
        ...extra,
      });
    },
    async setConfig(patch): Promise<void> {
      await (
        await models.getIntegrationRepository()
      ).update(workspace.id, integrationId, { config: { ...config, ...patch } });
    },
    setPrimary,
    stop: () => api.stop(),
  };
}

/** What the server logged (stderr) while `fn` ran: captured, not printed. */
export async function logsDuring(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}
