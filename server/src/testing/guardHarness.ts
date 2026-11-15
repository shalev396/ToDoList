/**
 * Test-only Express app for the response guard and error handler: one route per behaviour.
 * Callers set ENV before importing this module (config/environment.ts reads it at load time).
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { AppError } from '../errors/AppError.js';
import { ProviderNoAnswerError } from '../errors/ProviderNoAnswerError.js';
import {
  allowSecretKinds,
  errorHandler,
  responseFormatter,
} from '../middlewares/responseFormatter.js';

export const FAKE_GITHUB_TOKEN = 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123';
export const FAKE_DB_URL = 'mongodb://dev:FAKE-pw@db.example.com/x';
export const FAKE_JWT = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.FAKEsignatureFAKEsignature`;

export async function startGuardHarness(): Promise<{ base: string; stop: () => void }> {
  const app = express();
  app.use(responseFormatter);
  app.use(express.json());
  app.post('/echo', (_req, res) => {
    res.success({ ok: true });
  });
  app.get('/leak', (_req, res) => {
    res.success({ note: `pasted ${FAKE_GITHUB_TOKEN}` });
  });
  app.get('/session', (_req, res) => {
    allowSecretKinds(res, 'jwt');
    res.success({ idToken: FAKE_JWT });
  });
  app.get('/boom', () => {
    throw new Error(`connect failed: ${FAKE_DB_URL}`);
  });
  app.get('/conflict', () => {
    throw new AppError(409, 'Version conflict');
  });
  app.get('/unavailable', () => {
    throw new AppError(503, 'db host secret-ish detail');
  });
  app.get('/coded', () => {
    throw new AppError(409, 'That slug is already taken', { code: 'slug_taken' });
  });
  app.get('/coded-reply', (_req, res) => {
    res.error('Incorrect email or password.', 401, 'invalid_credentials');
  });
  app.get('/coded-unavailable', () => {
    throw new AppError(503, 'db host detail', { code: 'workspace_full' });
  });
  app.get('/no-answer', () => {
    throw new ProviderNoAnswerError('jira');
  });
  app.use(errorHandler);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => {
      resolve(s);
    });
  });
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    stop: (): void => {
      server.close();
    },
  };
}

/** Captures everything written to stderr while `fn` runs (the logger writes there). */
export async function captureStderr(fn: () => Promise<void>): Promise<string> {
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
