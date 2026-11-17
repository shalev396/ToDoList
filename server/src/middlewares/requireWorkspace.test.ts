import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { startMemoryMongo, type MemoryMongo } from '../testing/memoryMongo.js';
import type { WorkspaceRequest } from '../types/express.js';

let mongo: MemoryMongo;
let server: Server;
let base = '';
const ids = { workspace: '', deleted: '' };

before(async () => {
  mongo = await startMemoryMongo('todolist_require_ws');
  Object.assign(process.env, { ENV: 'dev', DATABASE_URL: mongo.uri });
  const express = (await import('express')).default;
  const { initDB } = await import('../config/database.js');
  const { responseFormatter } = await import('./responseFormatter.js');
  const { requireWorkspace } = await import('./requireWorkspace.js');
  const { getWorkspaceRepository, getMembershipRepository } = await import('../models/index.js');
  await initDB();

  const workspaces = await getWorkspaceRepository();
  const memberships = await getMembershipRepository();
  const ws = await workspaces.create({
    name: 'Study group',
    slug: 'study-group',
    ownerId: 'u-owner',
  });
  const gone = await workspaces.create({ name: 'Gone', slug: 'gone', ownerId: 'u-owner' });
  ids.workspace = ws.id;
  ids.deleted = gone.id;
  await memberships.create(ws.id, { userId: 'u-owner', role: 'owner' });
  await memberships.create(ws.id, { userId: 'u-viewer', role: 'viewer' });
  await memberships.create(gone.id, { userId: 'u-owner', role: 'owner' });
  await workspaces.softDelete(gone.id);

  const app = express();
  app.use(responseFormatter);
  // Test stand-in for expressAuth: the caller's user id comes from a header.
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string; cognitoSub: string } }).user = {
      id: req.header('x-user') ?? '',
      cognitoSub: 'sub',
    };
    next();
  });
  app.get('/w/:wid/read', requireWorkspace('viewer'), (req, res) => {
    const { workspace } = req as unknown as WorkspaceRequest;
    res.success({ id: workspace.id, role: workspace.role, keys: Object.keys(workspace).sort() });
  });
  app.get('/w/:wid/admin', requireWorkspace('owner'), (_req, res) => {
    res.success({ ok: true });
  });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  server.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect();
  await mongo.stop();
});

async function get(
  path: string,
  user: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { headers: { 'x-user': user } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('requireWorkspace', () => {
  it('sets the workspace context for a member', async () => {
    const res = await get(`/w/${ids.workspace}/read`, 'u-viewer');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body['data'], {
      id: ids.workspace,
      role: 'viewer',
      // A workspace is shared whole: the context carries no area scope.
      keys: ['id', 'role', 'settings'],
    });
  });

  it('answers 404, never 403, to a non-member', async () => {
    assert.equal((await get(`/w/${ids.workspace}/read`, 'u-stranger')).status, 404);
    assert.equal((await get(`/w/${ids.workspace}/admin`, 'u-stranger')).status, 404);
  });

  it('answers 404 for a deleted or unknown workspace', async () => {
    assert.equal((await get(`/w/${ids.deleted}/read`, 'u-owner')).status, 404);
    assert.equal((await get('/w/does-not-exist/read', 'u-owner')).status, 404);
  });

  it('answers 403 to a member below the required role', async () => {
    assert.equal((await get(`/w/${ids.workspace}/admin`, 'u-viewer')).status, 403);
    assert.equal((await get(`/w/${ids.workspace}/admin`, 'u-owner')).status, 200);
  });
});
