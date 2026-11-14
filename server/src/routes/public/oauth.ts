import { Router } from 'express';
import { GoogleCalendarOAuthController, ProviderOAuthController } from '../../controllers/index.js';

/**
 * OAuth callbacks (INTEGRATIONS-SETUP.md, conventions): the provider redirects the browser here,
 * so they are public. Authenticated by the single-use `state` (bound to the user, the workspace
 * and the browser) and PKCE; see services/googleCalendarOAuth.ts.
 */
const router = Router();

// ─── GET /api/public/oauth/google-calendar/callback?code&state ──────────────

/**
 * Always a 302 to the fixed client page: `/<lng>/integrations?connected=<iid>`, or
 * `?oauth_error=<code>` (types/errorCodes.ts). Never a token, a code or a caller-supplied URL.
 */
router.get('/google-calendar/callback', GoogleCalendarOAuthController.callback);

// ─── GET /api/public/oauth/:provider/callback?code&state ────────────────────

/**
 * GitHub, Jira, ClickUp and Linear (services/oauth/service.ts): the same contract as Google
 * Calendar's callback. Any other `:provider` is a 404.
 */
router.get('/:provider/callback', ProviderOAuthController.callback);

export { router as oauthRouter };
