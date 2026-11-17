/** An IANA-style name ("Asia/Jerusalem", "UTC", "Etc/GMT+2"), never a raw offset like "+02:00". */
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * The canonical spelling of a valid IANA time zone ("asia/jerusalem" → "Asia/Jerusalem"), or null
 * when the runtime's time zone database doesn't know it. Stored settings use this spelling, so
 * every consumer (Intl, MongoDB date operators) reads the same name.
 */
export function canonicalTimeZone(value: string): string | null {
  if (!IANA_NAME.test(value)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
