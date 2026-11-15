/**
 * Google Calendar connected with Google OAuth (`{refreshToken, scope}`; every call trades the
 * refresh token for an access token kept in memory for that call only), or read through a
 * service account (the demo's fixtures).
 *
 * - the calendar picker: calendarList, as `{id, summary, primary, accessRole}`;
 * - an event created from a to-do (insertEvent), and the push: the diff's ops applied through the
 *   Calendar API (writers/calendarOps.ts), both only inside the write session, so a read-only
 *   integration never writes; a dry run writes nothing and is always allowed;
 * - the pull after a push: Google-side edits and deletes of what was pushed;
 * - disconnect: the grant is revoked at Google, unless another live integration (in any
 *   workspace) uses the same Google account, since revoking ends the grant for all of them.
 */
import type { Caller } from '../../base/Caller.js';
import { AppError } from '../../../errors/AppError.js';
import { applyCommit } from '../../../gcal/commit.js';
import { ORIGIN, PAST_WINDOW_DAYS } from '../../../gcal/diff.js';
import { loadPlan, readGcalConfig, type PlanNarrowing } from '../../../gcal/plan.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import {
  getIntegrationRepository,
  getSyncRunRepository,
  getSyncStateRepository,
} from '../../../models/index.js';
import { googleTokenClient, refreshAccessToken } from '../../../services/googleOAuthClient.js';
import { logger } from '../../../services/logger.js';
import { ProviderHttpError, type ReadOnlyClient } from '../../../sync/http.js';
import { googleEndpoints } from '../../../sync/providers/googleEndpoints.js';
import type { AdapterContext } from '../../../sync/types.js';
import type { GoogleCalendarConfig } from '../../../types/integrations.js';
import type {
  CreateOptionsQuery,
  CreateOptionsResponseData,
} from '../../../types/providerCreate.js';
import { cachedCreateOptions } from '../../../services/providerCreate/funnel.js';
import { OAuthAuth } from '../auth/OAuthAuth.js';
import type {
  CalendarDryRun,
  CalendarProvider,
  CalendarPushRequest,
  GoogleCalendarEntry,
  Revocable,
  SupportsOAuth,
} from '../capabilities.js';
import type { TestableAdapter } from '../connectionTest.js';
import { Integration } from '../Integration.js';
import { IntegrationRegistry } from '../IntegrationRegistry.js';
import {
  CalendarApiError,
  calendarReader,
  calendarWriter,
  type CalendarReader,
  type CalendarWriter,
  type PlainEventBody,
} from '../writers/calendarApi.js';
import { applyOps, type OpResult } from '../writers/calendarOps.js';
import type { WriteResult } from '../writers/trackerWriter.js';

/** `{refreshToken, scope}` (OAuth) or `{clientEmail, privateKey}` (the demo's service account). */
export type GoogleCalendarSecret = Readonly<{
  refreshToken?: string;
  scope?: string;
  clientEmail?: string;
  privateKey?: string;
}>;

/** How long one push may write; the rest waits for the next run (API Gateway stops at 30 s). */
export const PUSH_BUDGET_MS = 20_000;

const MAX_CALENDAR_PAGES = 10;
const MAX_PULL_PAGES = 10;
const ACCESS_ROLES: ReadonlySet<string> = new Set(['owner', 'writer', 'reader', 'freeBusyReader']);

/** One calendar's pulled changes, in the shape the commit reads (gcal/commit.ts CalendarResult). */
interface PulledCalendar {
  id: string;
  events: Record<string, unknown>[];
  nextSyncToken: string | null;
  fullSync: boolean;
  reset: boolean;
  partial: boolean;
}

const statusOf = (error: unknown): number | null =>
  error instanceof CalendarApiError ? error.status : null;

function calendarEntry(raw: unknown): GoogleCalendarEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { id, summary, summaryOverride, primary, accessRole } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !/^\S{1,255}$/.test(id)) return null;
  const name =
    typeof summaryOverride === 'string' && summaryOverride.trim() !== ''
      ? summaryOverride
      : typeof summary === 'string' && summary.trim() !== ''
        ? summary
        : id;
  return {
    id,
    summary: name.slice(0, 200),
    primary: primary === true,
    accessRole:
      typeof accessRole === 'string' && ACCESS_ROLES.has(accessRole) ? accessRole : 'reader',
  };
}

/**
 * Lists one calendar's changes: incremental with the stored `syncToken` (a 410 is reported as
 * `reset`), otherwise in full from `timeMin`. Only events carrying our origin are kept, each with
 * `priv` (the private extended properties) the commit reads.
 */
async function pullOwnEvents(
  reader: CalendarReader,
  calendarId: string,
  syncToken: string | null,
  timeMin: string,
): Promise<PulledCalendar> {
  const out: PulledCalendar = {
    id: calendarId,
    events: [],
    nextSyncToken: null,
    fullSync: syncToken === null,
    reset: false,
    partial: false,
  };
  const query = syncToken === null ? { timeMin } : { syncToken };
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
    let result;
    try {
      result = await reader.list(calendarId, query, pageToken);
    } catch (error) {
      if (syncToken !== null && statusOf(error) === 410) return { ...out, reset: true };
      throw error;
    }
    for (const raw of result.items) {
      const ext = raw['extendedProperties'] as { private?: Record<string, unknown> } | undefined;
      const priv = ext?.private ?? null;
      if (priv?.['origin'] === ORIGIN) out.events.push({ ...raw, priv });
    }
    if (result.nextPageToken === null) {
      out.nextSyncToken = result.nextSyncToken;
      return out;
    }
    pageToken = result.nextPageToken;
  }
  return { ...out, partial: true };
}

export class GoogleCalendarIntegration
  extends Integration<GoogleCalendarConfig, GoogleCalendarSecret, CalendarWriter>
  implements CalendarProvider, Revocable, SupportsOAuth<GoogleCalendarSecret>
{
  /** The access token is fetched per call (refreshAccessToken), so the headers come from it. */
  static readonly #oauth = new OAuthAuth<GoogleCalendarSecret>({
    provider: 'google_calendar',
    refresh: 'per_call',
    headers: (): Record<string, string> => ({}),
  });

  static {
    IntegrationRegistry.instance.register(
      'google_calendar',
      (data) => new GoogleCalendarIntegration(data),
    );
  }

  private constructor(data: IntegrationData) {
    super(data);
  }

  get oauth(): OAuthAuth<GoogleCalendarSecret> {
    return GoogleCalendarIntegration.#oauth;
  }

  /** Its owner: the account's calendars (calendarList), primary first. */
  async listCalendars(caller: Caller): Promise<GoogleCalendarEntry[]> {
    this.assertOwner(caller);
    return this.#withAccessToken(async (accessToken, client) => {
      const entries: GoogleCalendarEntry[] = [];
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_CALENDAR_PAGES; page += 1) {
        const url = new URL(`${googleEndpoints().calendar}/users/me/calendarList`);
        url.searchParams.set('maxResults', '250');
        if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
        const { data } = await client.getJson<{ items?: unknown; nextPageToken?: unknown }>(
          url.href,
          { authorization: `Bearer ${accessToken}` },
        );
        const items = Array.isArray(data.items) ? (data.items as unknown[]) : [];
        for (const item of items) {
          const entry = calendarEntry(item);
          if (entry !== null && !entries.some((known) => known.id === entry.id)) {
            entries.push(entry);
          }
        }
        const next = data.nextPageToken;
        if (typeof next !== 'string' || next === '' || next === pageToken) break;
        pageToken = next;
      }
      return entries.sort((a, b) => Number(b.primary) - Number(a.primary));
    });
  }

  /**
   * The create funnel's one step: the calendars an event can be created in (`owner` and
   * `writer`). Only for a caller who could create here now (a read & write integration).
   */
  async createOptions(
    caller: Caller,
    query: CreateOptionsQuery,
  ): Promise<CreateOptionsResponseData> {
    this.assertWritable(caller);
    if (query.step !== 'calendar') throw new AppError(400, 'step: not a step of this provider');
    return cachedCreateOptions(`${caller.userId}|${this.id}|${JSON.stringify(query)}`, async () => {
      const calendars = await this.listCalendars(caller);
      return {
        options: calendars
          .filter((entry) => entry.accessRole === 'owner' || entry.accessRole === 'writer')
          .map((entry) => ({
            id: entry.id,
            name: entry.summary,
            ...(entry.primary ? { hint: 'primary' } : {}),
          })),
      };
    });
  }

  /**
   * H5: one event created from a to-do, in the calendar the user picked, through the write
   * session. The event id is fixed by the caller (derived from the request id), so a repeat
   * answers 409 and is the same event. Only an answer from Google is about the event; a grant or
   * refresh that fails before anything is sent is not, so it propagates.
   */
  async insertEvent(
    caller: Caller,
    calendarId: string,
    event: PlainEventBody,
  ): Promise<WriteResult> {
    try {
      const written = await this.withWriteSession(caller, async ({ writer }) => {
        try {
          return await writer.insert(calendarId, event);
        } catch (error) {
          if (statusOf(error) !== 409) throw error;
          return { id: event.id, etag: undefined, updated: undefined };
        }
      });
      const eid = Buffer.from(`${written.id} ${calendarId}`).toString('base64url');
      return {
        kind: 'created',
        record: {
          id: written.id,
          key: null,
          url: `https://calendar.google.com/calendar/event?eid=${eid}`,
        },
      };
    } catch (error) {
      if (!(error instanceof CalendarApiError)) throw error;
      const { status } = error;
      if (status === null || status >= 500) return { kind: 'unknown' };
      if (status === 401) return { kind: 'refused', reason: 'auth' };
      if (status === 403) return { kind: 'refused', reason: 'forbidden' };
      if (status === 429) return { kind: 'refused', reason: 'rate_limited' };
      return { kind: 'refused', reason: 'rejected' };
    }
  }

  /** Its owner: what a push would create, update and remove now. Nothing is written. */
  async dryRun(
    caller: Caller,
    narrowing?: PlanNarrowing,
    now: Date = new Date(),
  ): Promise<CalendarDryRun> {
    this.assertOwner(caller);
    const plan = await loadPlan(this.toJSON(), now, narrowing);
    return { dryRun: true, counts: plan.counts, entries: plan.entries, skipped: plan.skipped };
  }

  /**
   * A push, start to commit: a `SyncRuns` row (trigger `calendar_push`), the ops through the
   * Calendar API inside the write session (refused first for a read-only integration, before any
   * run is recorded), the pull that follows, then the commit (gcal/commit.ts: links, audit, the
   * run's counts). Ops left when PUSH_BUDGET_MS runs out wait for the next run. Returns the run's
   * id. 409 to reconnect, 502 when Google is silent.
   */
  async push(caller: Caller, { ops, now }: CalendarPushRequest): Promise<string> {
    this.assertWritable(caller);
    const { workspaceId } = this;
    const runs = await getSyncRunRepository();
    const run = await runs.create(workspaceId, {
      integrationId: this.id,
      trigger: 'calendar_push',
      status: 'running',
      startedAt: now,
    });
    let opResults: OpResult[];
    try {
      const deadline = Date.now() + PUSH_BUDGET_MS;
      opResults = await this.withWriteSession(caller, ({ writer }) =>
        applyOps(writer, ops, deadline),
      );
    } catch (error) {
      if (error instanceof AppError) {
        // The gate refused meanwhile (the owner switched it to read-only): nothing was written.
        await runs.updateIfStatus(workspaceId, run.id, ['running'], {
          status: 'failed',
          finishedAt: new Date(),
          error: { code: error.code ?? 'refused', message: error.message },
        });
        throw error;
      }
      const authFailed = error instanceof ProviderHttpError && error.code === 'auth_failed';
      await runs.updateIfStatus(workspaceId, run.id, ['running'], {
        status: 'failed',
        finishedAt: new Date(),
        error: authFailed
          ? { code: 'auth_failed', message: 'Reconnect required' }
          : { code: 'calendar_unreachable', message: 'Google Calendar did not answer' },
      });
      if (authFailed) {
        // As a sync would: the integration waits for its owner to reconnect.
        await (
          await getIntegrationRepository()
        ).recordSyncResult(workspaceId, this.id, {
          status: 'error',
          lastError: { code: 'auth_failed', message: 'Reconnect required' },
        });
        throw new AppError(409, 'Google refused the connection: reconnect Google Calendar');
      }
      logger.warn('A Google Calendar push failed', {
        integrationId: this.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new AppError(502, 'Google Calendar did not answer. Try again in a moment.');
    }
    // The pull that follows the writes (their etags are the links' by then, so our echoes are
    // skipped): Google-side edits and deletes of what we pushed. A failed pull never fails the
    // push; the token is kept and the next run lists again.
    const calendars = await this.#pullAfterPush(now);
    await applyCommit(this.toJSON(), { runId: run.id, opResults, calendars }, new Date());
    return run.id;
  }

  /**
   * Disconnect: hands the grant back to Google (best effort: never throws). Left in place when
   * another live integration uses the same Google account, whose grant revoking would end too.
   */
  async revoke(): Promise<void> {
    try {
      if (await this.sharesGrant()) return;
      await this.withReadSession(async ({ secret }) => {
        await googleTokenClient().revokeToken(secret.refreshToken ?? '');
      });
    } catch (error) {
      logger.warn('A Google Calendar grant could not be revoked', {
        integrationId: this.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  /** The Calendar API writer, acting with a fresh access token for this one session. */
  protected async createWriter(secret: GoogleCalendarSecret): Promise<CalendarWriter> {
    return calendarWriter(await refreshAccessToken(googleTokenClient(), secret.refreshToken ?? ''));
  }

  protected probe(adapter: TestableAdapter, context: AdapterContext): Promise<unknown> {
    return adapter.test(context);
  }

  /** Runs `fn` with a fresh access token for the integration's grant (a read session). */
  async #withAccessToken<T>(
    fn: (accessToken: string, client: ReadOnlyClient) => Promise<T>,
  ): Promise<T> {
    return this.withReadSession(async ({ secret }) => {
      const client = googleTokenClient();
      const accessToken = await refreshAccessToken(client, secret.refreshToken ?? '');
      return fn(accessToken, client);
    });
  }

  /** The pull for the push target, with its own grant; nothing when it fails. */
  async #pullAfterPush(now: Date): Promise<PulledCalendar[]> {
    const target = readGcalConfig(this.toJSON()).targetCalendarId;
    if (target === null) return [];
    try {
      const state = await (
        await getSyncStateRepository()
      ).get(this.workspaceId, this.id, `gcal:${target}`);
      const timeMin = new Date(
        now.getTime() - PAST_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const calendars = [{ id: target, syncToken: state?.syncToken ?? null }];
      return await this.#withAccessToken(async (accessToken) => {
        const reader = calendarReader(accessToken);
        const results: PulledCalendar[] = [];
        for (const cal of calendars) {
          results.push(await pullOwnEvents(reader, cal.id, cal.syncToken, timeMin));
        }
        return results;
      });
    } catch (error) {
      logger.warn('A Google Calendar pull failed', {
        integrationId: this.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return [];
    }
  }
}
