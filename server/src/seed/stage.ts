/**
 * Where demo data may be written: the dev and qa stages only, never prod. Demo data is a sample
 * workspace with FAKE integrations (seedWorkspace.ts), for trying the app and for the stage-backed
 * browser tests, which need data without real providers. Pure, with no environment read.
 */
import type { Env } from '../types/env.d.ts';

/** The stages where a new workspace may load demo data. */
export const DEMO_DATA_STAGES: readonly Env[] = ['dev', 'qa'];

export function isDemoDataStage(env: string | undefined): boolean {
  return (DEMO_DATA_STAGES as readonly (string | undefined)[]).includes(env);
}

/** Null when demo data may be loaded with this ENV; otherwise why it is refused. */
export function demoDataRefusal(env: string | undefined): string | null {
  if (isDemoDataStage(env)) return null;
  const actual = env === undefined || env === '' ? 'ENV is not set' : `ENV is "${env}"`;
  return `Demo data loads only with ENV=dev or ENV=qa (${actual})`;
}
