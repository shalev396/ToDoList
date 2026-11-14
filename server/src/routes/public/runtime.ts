import { Router } from 'express';
import { RuntimeController } from '../../controllers/runtime.js';
import type { Env } from '../../types/env.d.ts';

const router = Router();

// ─── GET /api/public/runtime ────────────────────────────────────────────────

/**
 * What the client adapts to on this stage, and never a secret: the stage and whether a new
 * workspace can load demo data (dev and qa only, as createWorkspace decides).
 */
export interface RuntimeResponseData {
  env: Env;
  demoDataAvailable: boolean;
}

router.get('/', RuntimeController.get);

export { router as runtimeRouter };
