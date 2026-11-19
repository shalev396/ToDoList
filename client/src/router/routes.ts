// Path segments without leading slash or locale. Single source of truth for all paths.
// These will be prefixed with /:lng in the router. Use pathTo(ROUTES.*, lng) for links.
const AUTH_BASE = 'auth' as const;
const LEGAL_BASE = 'legal' as const;
const SETTINGS_BASE = 'settings' as const;

export const ROUTES = {
  HOME: '',
  DASHBOARD: 'dashboard',
  PRICING: 'pricing',
  PROFILE: 'profile',
  EDIT_PROFILE: 'profile/edit',
  EDIT_PROFILE_SEGMENT: 'edit',
  ONBOARDING: 'onboarding',
  /** The consent page of an agent signing in; takes `?request=<id>`. */
  AUTHORIZE_AGENT: 'authorize-agent',
  /** Route pattern; build links with invitePath(). */
  INVITE: 'invites/:token',
  /** Route pattern of a join link ("anyone with the link"); build links with joinPath(). */
  JOIN: 'join/:token',
  /** Route pattern; build links with topicPath(). */
  TOPIC: 't/:topic',
  /** Route pattern; build links with topicPath(). */
  TOPIC_GROUP: 't/:topic/:group',
  INTEGRATIONS: 'integrations',
  TEMPLATES: 'templates',
  SETTINGS: SETTINGS_BASE,
  MEMBERS: `${SETTINGS_BASE}/members`,
  AGENT_KEYS: `${SETTINGS_BASE}/agent-keys`,
  /** My own travel: places, rules, factors and default places (editors and owners). */
  TRAVEL: `${SETTINGS_BASE}/travel`,
  /** Route pattern of a local item's source link (server: localItemUrl); see ItemLinkPage. */
  ITEM_LINK: 'w/:wid/items/:id',
  AUTH: {
    BASE: AUTH_BASE,
    SEGMENTS: {
      LOGIN: 'login',
      SIGNUP: 'signup',
      FORGOT_PASSWORD: 'forgot-password',
      RESET_PASSWORD: 'reset-password',
      CONFIRM_SIGNUP: 'confirm-signup',
    },
    LOGIN: `${AUTH_BASE}/login`,
    SIGNUP: `${AUTH_BASE}/signup`,
    FORGOT_PASSWORD: `${AUTH_BASE}/forgot-password`,
    RESET_PASSWORD: `${AUTH_BASE}/reset-password`,
    CONFIRM_SIGNUP: `${AUTH_BASE}/confirm-signup`,
  },
  LEGAL: {
    BASE: LEGAL_BASE,
    SEGMENTS: {
      PRIVACY: 'privacy',
      TERMS: 'terms',
    },
    PRIVACY: `${LEGAL_BASE}/privacy`,
    TERMS: `${LEGAL_BASE}/terms`,
  },
} as const;

export type RouteKey = keyof typeof ROUTES;
export type RoutePath = (typeof ROUTES)[RouteKey];

/**
 * Build full path with locale. Use everywhere instead of hardcoding `/${lng}/${segment}`.
 * Changing URL structure in one place updates the entire app.
 */
export function pathTo(segment: string, lng: string): string {
  const trimmed = segment.replace(/^\/+/, '');
  return trimmed ? `/${lng}/${trimmed}` : `/${lng}`;
}

/** A topic page (`t/work`), or one group in it (`t/college/<container id>`). */
export function topicPath(topic: string, group?: string): string {
  const base = `t/${encodeURIComponent(topic)}`;
  return group === undefined ? base : `${base}/${encodeURIComponent(group)}`;
}

/** The accept page of an invite link. */
export function invitePath(token: string): string {
  return `invites/${encodeURIComponent(token)}`;
}

/** The page of a join link ("anyone with the link"). */
export function joinPath(token: string): string {
  return `join/${encodeURIComponent(token)}`;
}
