/**
 * Test-only: the whole API (createApp) on a throwaway MongoDB, run as the dev stage with every
 * AWS service and outside call replaced by a test seam (testSeams.ts). Sign-in mints a test ID
 * token (testAuth.ts) for any email.
 *
 * config/environment.ts reads process.env once, at import: start the harness before importing
 * anything that reads it, and import those modules dynamically afterwards.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { startMemoryMongo } from './memoryMongo.js';
import { defaultNameFor, mintTestToken, testSubForEmail } from './testAuth.js';
import { installTestSeams, TEST_STAGE_ENV, type TestSeams } from './testSeams.js';

export interface ApiResponse {
  status: number;
  /** The parsed JSON body; null for an empty one (204). */
  body: Record<string, unknown> | null;
  /** The raw body, for "never contains" checks. */
  text: string;
  /** Response headers, lower-case names (e.g. `retry-after`). */
  headers: Record<string, string>;
}

export interface ApiHarness {
  /** The API's origin on this machine, e.g. http://127.0.0.1:41234 (for a local peer that calls back). */
  baseUrl: string;
  /** The seams in place: the emails the app sent, the in-memory bucket. */
  seams: TestSeams;
  call(
    method: string,
    path: string,
    options?: { token?: string; body?: unknown },
  ): Promise<ApiResponse>;
  /**
   * Signs in as `email` (the first sign-in creates the user, as Cognito's login does): a test ID
   * token and the login answer's data (`user`, `tokens`, the workspace status).
   */
  login(email: string): Promise<{ token: string; data: Record<string, unknown> }>;
  stop(): Promise<void>;
}

/**
 * Signs in as `email` the way Cognito's login does for the app (the first sign-in creates the
 * user), with a test ID token instead of Cognito's: the token and the login answer's data. Needs
 * the test seams (testSeams.ts) and a database.
 */
export async function loginForTests(
  rawEmail: string,
): Promise<{ token: string; data: Record<string, unknown> }> {
  const { User } = await import('../classes/index.js');
  const { workspaceStatus } = await import('../services/workspaces.js');
  const email = rawEmail.trim().toLowerCase();
  const sub = testSubForEmail(email);
  const existing = await User.findByCognitoSub(sub);
  const name = existing?.name ?? defaultNameFor(email);
  const user = await User.upsertFromLogin(sub, email, name);
  const token = mintTestToken({ sub, email, name });
  const data: Record<string, unknown> = {
    user: { id: user.cognitoSub, email: user.email ?? email, name: user.name ?? name },
    tokens: { idToken: token, refreshToken: '', expiresIn: 3600 },
    ...(await workspaceStatus(user)),
  };
  return { token, data };
}

export async function startApiHarness(dbName: string): Promise<ApiHarness> {
  const mongo = await startMemoryMongo(dbName);
  Object.assign(process.env, { ...TEST_STAGE_ENV, DATABASE_URL: mongo.uri });
  const seams = await installTestSeams();
  const { initDB, syncDB } = await import('../config/database.js');
  const { createApp } = await import('../app.js');
  await initDB();
  await syncDB();
  const server = await new Promise<Server>((resolve) => {
    const listening = createApp().listen(0, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  const call: ApiHarness['call'] = async (method, path, options = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    const body = text === '' ? null : (JSON.parse(text) as Record<string, unknown>);
    return { status: response.status, body, text, headers: Object.fromEntries(response.headers) };
  };

  return {
    baseUrl: base,
    seams,
    call,
    login: loginForTests,
    stop: async (): Promise<void> => {
      server.close();
      const mongoose = (await import('mongoose')).default;
      await mongoose.disconnect();
      await mongo.stop();
    },
  };
}
