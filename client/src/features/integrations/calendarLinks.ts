/** Google's help page on sharing a calendar. */
export const GOOGLE_SHARE_HELP_URL = 'https://support.google.com/calendar/answer/37082';

/**
 * Where one calendar's settings (sharing, the secret iCal address) are in Google Calendar: the
 * settings page names the calendar by its id as URL-safe base64 of the UTF-8 bytes, without padding.
 */
export function calendarSettingsUrl(calendarId: string): string {
  const bytes = new TextEncoder().encode(calendarId);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `https://calendar.google.com/calendar/u/0/r/settings/calendar/${encoded}`;
}
