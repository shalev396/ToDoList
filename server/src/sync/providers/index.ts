/**
 * Every provider adapter, registered by importing its module (each one calls registerAdapter()
 * at its top level). One line per provider, e.g.:
 *
 *   import './jira.js';
 *
 * runSync.ts imports this file, so every sync entry point (the worker, the seed, tests) has
 * all adapters. Empty until the provider tasks add theirs.
 */
export {};
import './jira.js';
import './clickup.js';
import './linear.js';
import './google_calendar.js';
import './github.js';
import './moodle.js';
