import { type RequestHandler } from 'express';
import { environment } from '../config/environment.js';
import type { RuntimeResponseData } from '../routes/public/runtime.js';
import { isDemoDataStage } from '../seed/stage.js';
import type { Env } from '../types/env.d.ts';

/** Built field by field, so nothing else from the configuration can reach the response. */
export function runtimeInfo(stage: { env: Env }): RuntimeResponseData {
  return {
    env: stage.env,
    demoDataAvailable: isDemoDataStage(stage.env),
  };
}

const get: RequestHandler = (_req, res): void => {
  const data: RuntimeResponseData = runtimeInfo({ env: environment.env });
  res.success(data);
};

export const RuntimeController = { get } as const;
