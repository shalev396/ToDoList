import { Router } from 'express';
import { dashboardRouter } from './dashboard.js';
import { accountRouter } from './account.js';
import { uploadsRouter } from './uploads.js';
import { queryRouter } from './query.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';
import { workspacesRouter } from './workspaces.js';
import { membersRouter } from './members.js';
import { invitesRouter } from './invites.js';
import { dashboardsRouter } from './dashboards.js';
import { builderRouter } from './builder.js';
import { viewsRouter } from './views.js';
import { itemsRouter } from './items.js';
import { agentKeysRouter } from './agentKeys.js';
import { integrationsRouter } from './integrations.js';
import { syncRouter } from './sync.js';
import { gcalSyncRouter } from './gcalSync.js';
import { primaryCalendarRouter } from './primaryCalendar.js';
import { connectLinksRouter } from './connectLinks.js';
import { topicsRouter } from './topics.js';
import { providerCreateRouter } from './providerCreate.js';
import { attributesRouter } from './attributes.js';

const router = Router();

router.use('/dashboard', dashboardRouter);
router.use('/uploads', uploadsRouter);
router.use('/workspaces/:wid/query', requireWorkspace('viewer'), queryRouter);
// Workspaces: each router holds full paths (/workspaces/:wid/…, /me/invites, /invites/…).
router.use('/', workspacesRouter);
router.use('/', membersRouter);
router.use('/', invitesRouter);
// Dashboards, the builder and views: full paths under /workspaces/:wid/…, a role per route.
router.use('/', dashboardsRouter);
router.use('/', builderRouter);
router.use('/', viewsRouter);
router.use('/', topicsRouter);
router.use('/', attributesRouter);
router.use('/', itemsRouter);
router.use('/', providerCreateRouter);
router.use('/', agentKeysRouter);
router.use('/', integrationsRouter);
router.use('/', syncRouter);
router.use('/', gcalSyncRouter);
router.use('/', primaryCalendarRouter);
router.use('/', connectLinksRouter);
router.use('/', accountRouter);

export { router as privateRouter };
