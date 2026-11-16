import type { RequestHandler } from 'express';

import { runWithRequestMemo } from '../services/requestMemo.js';

/** First in the app: the rest of every request runs with its own empty memo (requestMemo.ts). */
export const requestMemo: RequestHandler = (_req, _res, next) => {
  runWithRequestMemo(next);
};
