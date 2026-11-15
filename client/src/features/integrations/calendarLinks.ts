/** Google's help page on sharing a calendar. */
export const GOOGLE_SHARE_HELP_URL = 'https://support.google.com/calendar/answer/37082';

/**
 * Where one calendar's settings (sharing, the secret iCal address) are in Google Calendar: the
 * settings page names the calendar by its id as URL-safe base64 of the UTF-8 bytes, without padding.
 * With the Google account's email, `authuser` opens it under that account when several are
 * signed in.
 */
export function calendarSettingsUrl(calendarId: string, accountEmail?: string): string {
  const bytes = new TextEncoder().encode(calendarId);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const base = `https://calendar.google.com/calendar/u/0/r/settings/calendar/${encoded}`;
  return accountEmail === undefined || accountEmail === ''
    ? base
    : `${base}?authuser=${encodeURIComponent(accountEmail)}`;
}
