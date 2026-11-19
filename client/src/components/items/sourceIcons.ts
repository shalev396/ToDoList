import {
  siClickup,
  siGithub,
  siGooglecalendar,
  siJira,
  siLinear,
  siModelcontextprotocol,
  siMoodle,
} from 'simple-icons';
import type { Provider } from './types.ts';

/** A brand mark's name: every source but local to-dos, and MCP (agents). */
export type IconName = Exclude<Provider, 'local'> | 'mcp';

/**
 * Brand marks from Simple Icons (CC0), as 24×24 SVG paths, used only to name a source or an
 * integration. Importing them by name keeps every other icon out of the bundle.
 */
export const SOURCE_GLYPHS: Readonly<Record<IconName, string>> = {
  moodle: siMoodle.path,
  google_calendar: siGooglecalendar.path,
  jira: siJira.path,
  clickup: siClickup.path,
  linear: siLinear.path,
  github: siGithub.path,
  mcp: siModelcontextprotocol.path,
};
