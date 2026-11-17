/**
 * Where an item comes from.
 *
 * A local stand-in until the shared domain type is merged; a later merge replaces it with the
 * `Provider` union from the server's types.
 */
export type Provider =
  | 'google_calendar'
  | 'jira'
  | 'clickup'
  | 'linear'
  | 'moodle'
  | 'github'
  | 'local';
