/**
 * Moodle adapter (read-only mirror, DATA.md §8). GET requests only, the REST web-service protocol:
 * `<siteUrl>/webservice/rest/server.php?wstoken=<token>&wsfunction=<fn>&moodlewsrestformat=json&…`.
 *
 * - Secret `{token}`; site `config.siteUrl`. The token sits in the query string, so the client's
 *   errors never carry a URL or a response body (errors.ts), and `redactUrl` masks `wstoken`.
 * - Moodle answers a failed call with HTTP 200 and `{exception, errorcode, message}`. That is
 *   turned into a ProviderHttpError (`auth_failed` for token and access problems, `bad_response`
 *   otherwise); the message text is dropped because it can echo the token.
 * - `courses`: `core_enrol_get_users_courses` (userid from `core_webservice_get_site_info`) →
 *   containers `course:<id>`. Full listing, so a dropped course is swept.
 * - `assignments`: `mod_assign_get_assignments` (every enrolled course) plus one
 *   `mod_assign_get_submission_status` per assignment → items `assign:<id>`, `kind: assignment`.
 *   Full listing, not windowed.
 * - `events`: `core_calendar_get_calendar_events` over [now-30d, now+90d) (not the Timeline's
 *   action-events call, which drops activities the user already completed: a windowed sweep would
 *   then delete them). Due and close events become items `event:<id>`, `kind: deadline`; the
 *   `open` events and assignment events (owned by `assignments`) are skipped. Completion comes
 *   from `core_completion_get_activities_completion_status` per course (state 1 or 2 is `done`,
 *   closed at `timecompleted`). A windowed full listing (`window` on `dueAt`): older deadlines
 *   keep their history, and a completed deadline stays and turns `done`.
 * - A submission or completion lookup that fails (not an auth error) reports a `status_unavailable`
 *   failure under the record's prefixed id: the stored copy stays untouched and live, never reopened.
 * - No incremental mode: every run is a full run (`minIntervalMs` 1000).
 * - Due dates are epoch seconds with a time, so they are not all-day and not shifted to 23:59.
 */
import { ProviderHttpError } from '../errors.js';
import { createReadOnlyClient } from '../http.js';
import { registerAdapter } from '../registry.js';
import type {
  AdapterContext,
  AdapterFailure,
  AdapterPage,
  MappedContainer,
  MappedItem,
  ProviderAdapter,
  ResourceResult,
} from '../types.js';
import type { ItemStatus } from '../../types/domain.js';
import { asObject, asString } from './trackerCommon.js';

const PROVIDER = 'moodle' as const;
const MIN_INTERVAL_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_PAST_DAYS = 30;
const WINDOW_FUTURE_DAYS = 90;
/** Moodle error codes that mean "this token cannot do this": a reconnect is needed. */
const AUTH_ERROR_CODES = new Set([
  'invalidtoken',
  'accessexception',
  'invalidlogin',
  'forcepasswordchangenotice',
  'usernotfullysetup',
  'webservicesnotallowed',
  'requireloginerror',
]);

type Obj = Record<string, unknown>;

const obj = asObject;
const str = asString;
/** A Moodle id (number, or a digit string): returned as its decimal string. */
function idOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  return null;
}
function positiveInt(value: unknown): number | null {
  const id = idOf(value);
  return id === null ? null : Number(id);
}
/** Epoch seconds → Date; null for 0, missing or garbage (Moodle uses 0 for "not set"). */
function epochSeconds(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface MoodleMapEnv {
  /** The integration's `accountId` (written on every record). */
  accountId: string;
  /** `config.siteUrl` without a trailing slash. */
  siteUrl: string;
  /** The integration owner's user id: what `@me` resolves to. */
  connectedBy: string;
  /** The connected user's display name (site info), for `props.assigneeNames`. */
  userFullName: string | null;
}

export type MoodleContainerResult = { container: MappedContainer } | { failure: AdapterFailure };
export type MoodleItemResult = { item: MappedItem } | { failure: AdapterFailure };

/** The semester of a course start: "<year>-A" (Oct-Feb), "-B" (Mar-Jun), "-S" (Jul-Sep). */
export function moodleSemester(startSeconds: unknown, timeZone: string): string | null {
  const start = epochSeconds(startSeconds);
  if (start === null) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(start);
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const month = get('month');
  const kind = month >= 10 || month <= 2 ? 'A' : month <= 6 ? 'B' : 'S';
  return `${String(get('year'))}-${kind}`;
}

/** Submission status → normalized status (`submitted` is done; a draft is in progress). */
export function submissionStatusOf(raw: string | null): {
  status: ItemStatus;
  raw: string | null;
} {
  if (raw === 'submitted') return { status: 'done', raw };
  if (raw === 'draft') return { status: 'in_progress', raw };
  return { status: 'open', raw };
}

function assigneeNames(env: MoodleMapEnv): string[] {
  return env.userFullName === null ? [] : [env.userFullName];
}

export function mapMoodleCourse(
  raw: Obj,
  env: MoodleMapEnv,
  timeZone: string,
): MoodleContainerResult {
  const id = idOf(raw['id']);
  if (id === null) return { failure: { externalId: '', code: 'missing_id' } };
  const shortname = str(raw['shortname']);
  return {
    container: {
      type: 'course',
      name: str(raw['fullname']) ?? str(raw['displayname']) ?? shortname ?? `Course ${id}`,
      props: {
        shortname,
        moodleCourseId: Number(id),
        semester: moodleSemester(raw['startdate'], timeZone),
      },
      source: {
        provider: PROVIDER,
        accountId: env.accountId,
        externalId: `course:${id}`,
        key: shortname,
        url: `${env.siteUrl}/course/view.php?id=${id}`,
        updatedAtSource: null,
        etag: null,
        hash: null,
      },
    },
  };
}

/** Maps one assignment, given its submission status (`null` when unknown) and submission time. */
export function mapMoodleAssignment(
  raw: Obj,
  submission: string | null,
  submittedAt: Date | null,
  env: MoodleMapEnv,
): MoodleItemResult {
  const id = idOf(raw['id']);
  if (id === null) return { failure: { externalId: '', code: 'missing_id' } };
  const duedate = raw['duedate'];
  if (duedate !== undefined && duedate !== null && typeof duedate !== 'number') {
    return { failure: { externalId: `assign:${id}`, code: 'bad_due_date' } };
  }
  const courseId = idOf(raw['course']);
  const courseRef = courseId === null ? null : `course:${courseId}`;
  const cmid = positiveInt(raw['cmid']);
  const { status, raw: statusRaw } = submissionStatusOf(submission);
  const item: MappedItem = {
    kind: 'assignment',
    title: str(raw['name']) ?? `Assignment ${id}`,
    status,
    statusRaw,
    dueAt: epochSeconds(raw['duedate']),
    allDay: false,
    closedAt: status === 'done' ? submittedAt : null,
    assignees: [env.connectedBy],
    containerExternalId: courseRef,
    props: {
      courseId: positiveInt(raw['course']),
      cmid,
      modname: 'assign',
      submissionStatus: statusRaw,
      cutoffAt: epochSeconds(raw['cutoffdate'])?.toISOString() ?? null,
      gradingDueAt: epochSeconds(raw['gradingduedate'])?.toISOString() ?? null,
      assigneeNames: assigneeNames(env),
    },
    source: {
      provider: PROVIDER,
      accountId: env.accountId,
      externalId: `assign:${id}`,
      key: null,
      // No course module id, no view link: the engine reports missing_url.
      url: cmid === null ? '' : `${env.siteUrl}/mod/assign/view.php?id=${String(cmid)}`,
      updatedAtSource: epochSeconds(raw['timemodified']),
      etag: null,
      hash: null,
    },
  };
  return { item };
}

/** Maps one calendar action event (a quiz or another activity deadline). */
export function mapMoodleEvent(
  raw: Obj,
  env: MoodleMapEnv,
  completion: { done: boolean; at: Date | null } | null = null,
): MoodleItemResult {
  const id = idOf(raw['id']);
  if (id === null) return { failure: { externalId: '', code: 'missing_id' } };
  const externalId = `event:${id}`;
  const dueAt = epochSeconds(raw['timestart']) ?? epochSeconds(raw['timesort']);
  if (dueAt === null) return { failure: { externalId, code: 'bad_event_time' } };
  const course = obj(raw['course']);
  const courseId = positiveInt(course?.['id']) ?? positiveInt(raw['courseid']);
  const finished = completion?.done === true ? completion : null;
  const url = str(raw['url']) ?? str(obj(raw['action'])?.['url']) ?? '';
  const item: MappedItem = {
    kind: 'deadline',
    title: str(raw['name']) ?? str(raw['activityname']) ?? `Event ${id}`,
    status: finished === null ? 'open' : 'done',
    dueAt,
    allDay: false,
    closedAt: finished?.at ?? null,
    assignees: [env.connectedBy],
    containerExternalId: courseId === null ? null : `course:${String(courseId)}`,
    props: {
      courseId,
      modname: str(raw['modulename']),
      eventType: str(raw['eventtype']),
      assigneeNames: assigneeNames(env),
    },
    source: {
      provider: PROVIDER,
      accountId: env.accountId,
      externalId,
      key: null,
      url,
      updatedAtSource: null,
      etag: null,
      hash: null,
    },
  };
  return { item };
}

function siteUrlOf(ctx: AdapterContext): string {
  const value = ctx.integration.config['siteUrl'];
  return (typeof value === 'string' ? value : '').replace(/\/+$/, '');
}

/**
 * One web-service call. The token (the auth strategy's query) is added here and nowhere else. Moodle's own
 * error body (HTTP 200) becomes a ProviderHttpError without any of its text.
 */
async function callMoodle<T>(
  ctx: AdapterContext,
  wsfunction: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${siteUrlOf(ctx)}/webservice/rest/server.php`);
  for (const [name, value] of Object.entries(ctx.auth.query())) url.searchParams.set(name, value);
  url.searchParams.set('wsfunction', wsfunction);
  url.searchParams.set('moodlewsrestformat', 'json');
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const { data } = await ctx.client.getJson<unknown>(url.href);
  const body = obj(data);
  if (body !== null && typeof body['exception'] === 'string') {
    const code = typeof body['errorcode'] === 'string' ? body['errorcode'] : '';
    throw new ProviderHttpError(
      PROVIDER,
      200,
      AUTH_ERROR_CODES.has(code) ? 'auth_failed' : 'bad_response',
    );
  }
  return data as T;
}

interface SiteInfo {
  userid: number | null;
  fullname: string | null;
  sitename: string | null;
  username: string | null;
}

const siteInfoCache = new WeakMap<AdapterContext, Promise<SiteInfo>>();

function fetchSiteInfo(ctx: AdapterContext): Promise<SiteInfo> {
  const cached = siteInfoCache.get(ctx);
  if (cached !== undefined) return cached;
  const pending = callMoodle<Obj>(ctx, 'core_webservice_get_site_info').then((data) => ({
    userid: positiveInt(data['userid']),
    fullname: str(data['fullname']),
    sitename: str(data['sitename']),
    username: str(data['username']),
  }));
  siteInfoCache.set(ctx, pending);
  // A failed call must not stay cached for another resource of the same run.
  pending.catch(() => siteInfoCache.delete(ctx));
  return pending;
}

async function mapEnv(ctx: AdapterContext): Promise<MoodleMapEnv> {
  const info = await fetchSiteInfo(ctx);
  return {
    accountId: ctx.integration.accountId,
    siteUrl: siteUrlOf(ctx),
    connectedBy: ctx.integration.connectedBy,
    userFullName: info.fullname,
  };
}

const enrolledCache = new WeakMap<AdapterContext, Promise<unknown>>();

/** `core_enrol_get_users_courses`, called once per run and shared by courses and events. */
function enrolledCourses(ctx: AdapterContext, userId: number): Promise<unknown> {
  const cached = enrolledCache.get(ctx);
  if (cached !== undefined) return cached;
  const pending = callMoodle<unknown>(ctx, 'core_enrol_get_users_courses', {
    userid: String(userId),
  });
  enrolledCache.set(ctx, pending);
  pending.catch(() => enrolledCache.delete(ctx));
  return pending;
}

async function* fetchCourses(ctx: AdapterContext): AsyncGenerator<AdapterPage, ResourceResult> {
  const env = await mapEnv(ctx);
  const info = await fetchSiteInfo(ctx);
  if (info.userid === null) throw new ProviderHttpError(PROVIDER, 200, 'bad_response');
  const data = await enrolledCourses(ctx, info.userid);
  const containers: MappedContainer[] = [];
  const failures: AdapterFailure[] = [];
  for (const course of Array.isArray(data) ? data : []) {
    const result = mapMoodleCourse(obj(course) ?? {}, env, ctx.timeZone);
    if ('container' in result) containers.push(result.container);
    else failures.push(result.failure);
  }
  yield { resource: 'courses', containers, items: [], failures };
  return { nextState: {}, fullSync: true };
}

/** A lookup failure that is not an auth problem: the record is skipped, never reopened. */
function isLookupFailure(error: unknown): boolean {
  return error instanceof ProviderHttpError && error.code !== 'auth_failed';
}

/**
 * The submission status of one assignment. Null when the lookup failed (not an auth error): the
 * caller reports a failure for the record, so its stored copy stays as it is.
 */
async function submissionOf(
  ctx: AdapterContext,
  assignId: string,
): Promise<{ status: string | null; at: Date | null } | null> {
  try {
    const data = await callMoodle<Obj>(ctx, 'mod_assign_get_submission_status', {
      assignid: assignId,
    });
    const submission = obj(obj(data['lastattempt'])?.['submission']);
    return { status: str(submission?.['status']), at: epochSeconds(submission?.['timemodified']) };
  } catch (error) {
    if (isLookupFailure(error)) return null;
    throw error;
  }
}

async function* fetchAssignments(ctx: AdapterContext): AsyncGenerator<AdapterPage, ResourceResult> {
  const env = await mapEnv(ctx);
  const data = await callMoodle<Obj>(ctx, 'mod_assign_get_assignments');
  const items: MappedItem[] = [];
  const failures: AdapterFailure[] = [];
  const courses = Array.isArray(data['courses']) ? data['courses'] : [];
  for (const course of courses) {
    const courseObj = obj(course) ?? {};
    const assignments = Array.isArray(courseObj['assignments']) ? courseObj['assignments'] : [];
    for (const entry of assignments) {
      const raw: Obj = { course: courseObj['id'], ...(obj(entry) ?? {}) };
      const id = idOf(raw['id']);
      const submission = id === null ? { status: null, at: null } : await submissionOf(ctx, id);
      if (submission === null) {
        failures.push({ externalId: `assign:${id ?? ''}`, code: 'status_unavailable' });
        continue;
      }
      const result = mapMoodleAssignment(raw, submission.status, submission.at, env);
      if ('item' in result) items.push(result.item);
      else failures.push(result.failure);
    }
  }
  yield { resource: 'assignments', containers: [], items, failures };
  return { nextState: {}, fullSync: true };
}

/** The user's course ids, sorted. */
async function courseIds(ctx: AdapterContext, userId: number): Promise<number[]> {
  const data = await enrolledCourses(ctx, userId);
  return (Array.isArray(data) ? data : [])
    .map((course) => positiveInt(obj(course)?.['id']))
    .filter((id): id is number => id !== null)
    .sort((x, y) => x - y);
}

interface Completion {
  done: boolean;
  at: Date | null;
}

/**
 * Completion of one course's activities by cmid. Returns false when the lookup failed (not an
 * auth error): the course's deadlines are then reported as failures, never mapped as open.
 */
async function completionOf(
  ctx: AdapterContext,
  courseId: number,
  userId: number,
  into: Map<number, Completion>,
): Promise<boolean> {
  try {
    const data = await callMoodle<Obj>(ctx, 'core_completion_get_activities_completion_status', {
      courseid: String(courseId),
      userid: String(userId),
    });
    for (const entry of Array.isArray(data['statuses']) ? data['statuses'] : []) {
      const status = obj(entry);
      const cmid = positiveInt(status?.['cmid']);
      if (cmid === null) continue;
      const state = status?.['state'];
      into.set(cmid, {
        done: state === 1 || state === 2 || state === 3,
        at: epochSeconds(status?.['timecompleted']),
      });
    }
  } catch (error) {
    if (isLookupFailure(error)) return false;
    throw error;
  }
  return true;
}

function cmidOfUrl(url: string): number | null {
  try {
    return positiveInt(new URL(url).searchParams.get('id'));
  } catch {
    return null;
  }
}

const DEADLINE_TYPES = new Set(['due', 'close', 'expectcompletionon']);

async function* fetchEvents(ctx: AdapterContext): AsyncGenerator<AdapterPage, ResourceResult> {
  const env = await mapEnv(ctx);
  const info = await fetchSiteInfo(ctx);
  if (info.userid === null) throw new ProviderHttpError(PROVIDER, 200, 'bad_response');
  const ids = await courseIds(ctx, info.userid);
  const from = new Date(ctx.now.getTime() - WINDOW_PAST_DAYS * DAY_MS);
  const to = new Date(ctx.now.getTime() + WINDOW_FUTURE_DAYS * DAY_MS);
  const params: Record<string, string> = {
    'options[userevents]': '0',
    'options[siteevents]': '0',
    'options[timestart]': String(Math.floor(from.getTime() / 1000)),
    // `to` is exclusive in the window; Moodle's upper bound is inclusive.
    'options[timeend]': String(Math.floor(to.getTime() / 1000) - 1),
  };
  ids.forEach((id, index) => {
    params[`events[courseids][${String(index)}]`] = String(id);
  });
  const data = await callMoodle<Obj>(ctx, 'core_calendar_get_calendar_events', params);

  const completion = new Map<number, Completion>();
  const unknownCourses = new Set<number>();
  for (const id of ids) {
    if (!(await completionOf(ctx, id, info.userid, completion))) unknownCourses.add(id);
  }

  const items: MappedItem[] = [];
  const failures: AdapterFailure[] = [];
  for (const event of Array.isArray(data['events']) ? data['events'] : []) {
    const raw = obj(event) ?? {};
    const type = str(raw['eventtype']);
    // The assignments resource owns assignments; "open" and other events are not deadlines.
    if (raw['modulename'] === 'assign') continue;
    if (type === null || !DEADLINE_TYPES.has(type)) continue;
    const eventCourse = positiveInt(obj(raw['course'])?.['id']) ?? positiveInt(raw['courseid']);
    const eventId = idOf(raw['id']);
    if (eventId !== null && eventCourse !== null && unknownCourses.has(eventCourse)) {
      failures.push({ externalId: `event:${eventId}`, code: 'status_unavailable' });
      continue;
    }
    const cmid = cmidOfUrl(str(raw['url']) ?? '');
    const result = mapMoodleEvent(raw, env, cmid === null ? null : (completion.get(cmid) ?? null));
    if ('item' in result) items.push(result.item);
    else failures.push(result.failure);
  }
  yield { resource: 'events', containers: [], items, failures };
  return { nextState: {}, fullSync: true, window: { field: 'dueAt', from, to } };
}

export const moodleAdapter: ProviderAdapter = {
  provider: PROVIDER,
  createClient: (transport, clock) =>
    createReadOnlyClient({
      provider: PROVIDER,
      transport,
      minIntervalMs: MIN_INTERVAL_MS,
      ...(clock === undefined ? {} : { clock }),
    }),
  resources: () => ['courses', 'assignments', 'events'],
  fetch(ctx, resource) {
    if (resource === 'courses') return fetchCourses(ctx);
    if (resource === 'assignments') return fetchAssignments(ctx);
    if (resource === 'events') return fetchEvents(ctx);
    throw new Error(`moodle: unknown resource ${resource}`);
  },
  async test(ctx) {
    const info = await fetchSiteInfo(ctx);
    const label = info.fullname ?? info.username ?? info.sitename ?? 'Moodle';
    return info.userid === null
      ? { accountLabel: label }
      : { accountLabel: label, accountId: String(info.userid) };
  },
};

registerAdapter(moodleAdapter);
