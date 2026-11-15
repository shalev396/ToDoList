/**
 * Whether a pulled calendar event has guests beyond the calendar's owner (a change to it reaches
 * them): its `guestsCount`, or (an item pulled before that was kept) any attendee at all. The
 * fallback fails closed: the count may or may not hold the owner (an event made through the API
 * lists only its guests), so one attendee already asks whether to notify. Pure: the event's item
 * (CalendarEvent's hints) and Google's write-back (GoogleCalendarIntegration) read the same rule.
 */
export function eventHasGuests(props: Readonly<Record<string, unknown>>): boolean {
  const { guestsCount, attendeesCount } = props;
  if (typeof guestsCount === 'number') return guestsCount > 0;
  return typeof attendeesCount === 'number' && attendeesCount >= 1;
}
