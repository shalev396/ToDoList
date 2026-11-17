import type { TFunction } from 'i18next';
import {
  Building2,
  Cable,
  LayoutDashboard,
  LayoutTemplate,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { pathTo, ROUTES, topicPath } from '@/router/routes';
import { topicIconOf, topicShortcutKey } from '@/features/workspaces/topics';
import type { Role } from '@api-types/domain';
import type { TopicView } from '@api-types/api-contracts';

export interface NavEntry {
  id: string;
  label: string;
  to: string;
  icon: LucideIcon;
  /** `g` then this key. */
  shortcutKey?: string;
  /** Muted text at the end of the row (a non-owner's role). */
  trailing?: string;
  /** Active on sub-pages too (settings/members). */
  matchPrefix?: boolean;
  /** A topic's page: editors rename and delete it from its row. */
  topic?: TopicView;
}

export interface Navigation {
  /** Dashboard, then the workspace's topics (its pages). */
  primary: NavEntry[];
  /** After the divider: Integrations, Templates, and Settings (owners) or Workspace + my role. */
  secondary: NavEntry[];
}

export function buildNavigation({
  language,
  topics,
  role,
  t,
}: {
  language: string;
  topics: readonly TopicView[];
  role: Role | null;
  t: TFunction;
}): Navigation {
  const primary: NavEntry[] = [
    {
      id: 'dashboard',
      label: t('app.shell.dashboard'),
      to: pathTo(ROUTES.DASHBOARD, language),
      icon: LayoutDashboard,
      shortcutKey: 'd',
    },
    ...topics.map((topic): NavEntry => {
      const shortcutKey = topicShortcutKey(topic.slug);
      return {
        id: `topic-${topic.id}`,
        label: topic.name,
        to: pathTo(topicPath(topic.slug), language),
        icon: topicIconOf(topic),
        ...(shortcutKey === undefined ? {} : { shortcutKey }),
        matchPrefix: true,
        topic,
      };
    }),
  ];
  const settings: NavEntry =
    role === 'owner'
      ? {
          id: 'settings',
          label: t('app.shell.settings'),
          to: pathTo(ROUTES.SETTINGS, language),
          icon: Settings,
          shortcutKey: 's',
          matchPrefix: true,
        }
      : {
          id: 'settings',
          label: t('app.shell.workspace'),
          to: pathTo(ROUTES.SETTINGS, language),
          icon: Building2,
          shortcutKey: 's',
          matchPrefix: true,
          ...(role === null ? {} : { trailing: t(`app.roles.${role}`) }),
        };
  return {
    primary,
    secondary: [
      {
        id: 'integrations',
        label: t('app.shell.integrations'),
        to: pathTo(ROUTES.INTEGRATIONS, language),
        icon: Cable,
        shortcutKey: 'i',
      },
      {
        id: 'templates',
        label: t('app.shell.templates'),
        to: pathTo(ROUTES.TEMPLATES, language),
        icon: LayoutTemplate,
        shortcutKey: 't',
      },
      settings,
    ],
  };
}

/** "Workspace (Viewer)": the label with the trailing text, as one accessible name. */
export function navEntryName(entry: NavEntry): string {
  return entry.trailing === undefined ? entry.label : `${entry.label} (${entry.trailing})`;
}

/** Whether a nav entry is the current page. */
export function isNavEntryActive(entry: NavEntry, pathname: string): boolean {
  return entry.matchPrefix === true
    ? pathname === entry.to || pathname.startsWith(`${entry.to}/`)
    : pathname === entry.to;
}
