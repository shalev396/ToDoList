import { Router } from 'express';
import { authLimiter, oauthLimiter } from '../../middlewares/index.js';
import { authRouter } from './auth/index.js';
import { oauthRouter } from './oauth.js';
import { runtimeRouter } from './runtime.js';

const router = Router();

// Auth hits Cognito and SES, so it has its own, tighter budget. Future public routes that don't
// touch them can be mounted here without it.
router.use('/auth', authLimiter, authRouter);
// Stage facts for the client (no secrets, no database).
router.use('/runtime', runtimeRouter);

// OAuth callbacks: the provider sends the browser back here (state + PKCE, no session).
router.use('/oauth', oauthLimiter, oauthRouter);

export { router as publicRouter };
