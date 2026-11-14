import { CONNECTABLE_PROVIDERS, type ConnectableProvider } from '@api-types/integrations.ts';
import { limits, todosPerWorkspace } from './limits.ts';

/**
 * The order the pricing page names the integrations in: work tools, Google, then Moodle. A provider
 * the server adds to CONNECTABLE_PROVIDERS later is still listed, last.
 */
const INTEGRATION_ORDER: readonly ConnectableProvider[] = [
  'jira',
  'clickup',
  'linear',
  'github',
  'google_calendar',
  'google_drive',
  'moodle',
];

function rank(provider: ConnectableProvider): number {
  const index = INTEGRATION_ORDER.indexOf(provider);
  return index === -1 ? INTEGRATION_ORDER.length : index;
}

/** Every integration a workspace can connect (the server's list), in the page's order. */
export const supportedIntegrations: readonly ConnectableProvider[] = [
  ...CONNECTABLE_PROVIDERS,
].sort((a, b) => rank(a) - rank(b));

/** An i18n key and its numbers; `count` also picks the plural form. */
export interface PlanCopy {
  key: string;
  values?: Readonly<Record<string, number>>;
}

export type PlanFeatureId =
  | 'attributes'
  | 'integrations'
  | 'agents'
  | 'todos'
  | 'workspaces'
  | 'blocks'
  | 'views'
  | 'templates';

/** One line of the Individual plan: a title and, under it, an optional detail. */
export interface PlanFeature {
  id: PlanFeatureId;
  title: PlanCopy;
  detail?: PlanCopy;
}

const at = (path: string) => `pricing.plan.included.${path}`;

/**
 * The Individual plan's feature list. Every number comes from the shared limits (data/limits.ts,
 * read from server/src/types/limits.ts) or from the server's list of integrations, so the page
 * changes with them and the strings hold none.
 */
export const planFeatures: readonly PlanFeature[] = [
  {
    id: 'integrations',
    title: { key: at('integrations.title'), values: { count: supportedIntegrations.length } },
    detail: {
      key: at('integrations.detail'),
      values: { count: limits.integrationsPerUserPerWorkspace },
    },
  },
  {
    id: 'agents',
    title: { key: at('agents.title') },
    detail: { key: at('agents.detail'), values: { count: limits.agentKeysPerUser } },
  },
  {
    id: 'todos',
    title:
      todosPerWorkspace === null
        ? { key: at('todos.unlimited') }
        : { key: at('todos.limited'), values: { count: todosPerWorkspace } },
    detail: { key: at('todos.detail') },
  },
  {
    id: 'workspaces',
    title: { key: at('workspaces.title'), values: { count: limits.workspacesCreatedPerUser } },
    detail: { key: at('workspaces.detail'), values: { count: limits.membersPerWorkspace } },
  },
  {
    id: 'blocks',
    title: { key: at('blocks.title'), values: { count: limits.blocksPerPage } },
    detail: { key: at('blocks.detail') },
  },
  {
    id: 'views',
    title: { key: at('views.title'), values: { count: limits.viewsPerPage } },
    detail: { key: at('views.detail') },
  },
  {
    id: 'attributes',
    title: { key: at('attributes.title'), values: { count: limits.attributesPerWorkspace } },
    detail: { key: at('attributes.detail') },
  },
  {
    id: 'templates',
    title: { key: at('templates.title') },
    detail: { key: at('templates.detail') },
  },
];

/** "A, B and C" with the language's own separators (pricing.plan.list). */
export function joinList(items: readonly string[], separator: string, last: string): string {
  if (items.length <= 1) {
    return items.join('');
  }
  return `${items.slice(0, -1).join(separator)}${last}${items[items.length - 1] ?? ''}`;
}
