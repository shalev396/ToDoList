/**
 * Returning to a page after logging in: ProtectedRoute sends a signed-out visitor to the login
 * page with `?next=<the page>`, and the login page goes back there. Only app paths qualify, so the
 * parameter can never send anyone to another site.
 */
import { pathTo, ROUTES } from './routes.ts';

const APP_PATH = /^\/(en|he)(\/[^\\]*)?$/;

export function safeNextPath(raw: string | null): string | null {
  if (raw === null || raw === '' || raw.startsWith('//') || raw.includes('\\')) {
    return null;
  }
  if (!APP_PATH.test(raw)) {
    return null;
  }
  const page = raw.replace(/^\/(en|he)/, '').split(/[?#]/)[0] ?? '';
  if (page === `/${ROUTES.AUTH.BASE}` || page.startsWith(`/${ROUTES.AUTH.BASE}/`)) {
    return null;
  }
  return raw;
}

/** The login page, with `next` when there is somewhere other than the dashboard to return to. */
export function loginPathWithNext(language: string, target: string): string {
  const login = pathTo(ROUTES.AUTH.LOGIN, language);
  const next = safeNextPath(target);
  if (next === null || next.replace(/^\/(en|he)/, '') === `/${ROUTES.DASHBOARD}`) {
    return login;
  }
  return `${login}?next=${encodeURIComponent(next)}`;
}
