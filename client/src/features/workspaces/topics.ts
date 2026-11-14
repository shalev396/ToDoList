/**
 * Topics are the workspace's pages (H2, dynamic topics): free-text names, standardized slugs (the
 * `/t/<slug>` URLs), an optional icon and colour, and a sidebar order. Work, College and Personal
 * are only the defaults. Every member sees all of them: a workspace is shared whole.
 *
 * Items and containers carry a topic's id, or null: "Unsorted" (no topic, or one since deleted).
 */
import {
  Book,
  Briefcase,
  Building2,
  Code,
  Folder,
  GraduationCap,
  Heart,
  House,
  Leaf,
  Plane,
  Star,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from '@api-types/domain.ts';
import { isDefaultTopicSlug, type TopicColour, type TopicIcon } from '@api-types/topics.ts';

/**
 * What the helpers read of a topic (the API's TopicView has these, and its dates). Declared here,
 * not imported from the API contracts, so the unit tests stay free of the server's routes.
 */
export interface TopicLike {
  id: string;
  slug: string;
  name: string;
  icon: TopicIcon | null;
  colour: TopicColour | null;
  order: number;
}

export const TOPIC_ICON_COMPONENTS: Readonly<Record<TopicIcon, LucideIcon>> = {
  briefcase: Briefcase,
  'graduation-cap': GraduationCap,
  leaf: Leaf,
  folder: Folder,
  star: Star,
  heart: Heart,
  home: House,
  book: Book,
  code: Code,
  users: Users,
  building: Building2,
  plane: Plane,
};

/** Editors and owners add, rename and delete pages; viewers only read them. */
export function canManageTopics(role: Role | null): boolean {
  return role === 'editor' || role === 'owner';
}

/** A topic's icon; a folder when it has none. */
export function topicIconOf(topic: Pick<TopicLike, 'icon'>): LucideIcon {
  return topic.icon === null ? Folder : TOPIC_ICON_COMPONENTS[topic.icon];
}

/** The second key of a default topic's `g …` shortcut (`g w`, `g c`, `g p`). */
const DEFAULT_SHORTCUTS: Readonly<Record<string, string>> = {
  work: 'w',
  college: 'c',
  personal: 'p',
};

export function topicShortcutKey(slug: string): string | undefined {
  return isDefaultTopicSlug(slug) ? DEFAULT_SHORTCUTS[slug] : undefined;
}

/** In sidebar order (`order`, the server's own sort; stable otherwise). */
export function sortTopics<T extends Pick<TopicLike, 'order'>>(topics: readonly T[]): T[] {
  return [...topics].sort((a, b) => a.order - b.order);
}

/** The topic whose URL is `/t/<slug>`; slugs are exact (standardized, lower case). */
export function topicBySlug<T extends Pick<TopicLike, 'slug'>>(
  topics: readonly T[],
  slug: string,
): T | null {
  return topics.find((topic) => topic.slug === slug) ?? null;
}

export function topicById<T extends Pick<TopicLike, 'id'>>(
  topics: readonly T[],
  id: string | null,
): T | null {
  return id === null ? null : (topics.find((topic) => topic.id === id) ?? null);
}

/** A topic id as people read it: the topic's name, or `unsorted` (none, or since deleted). */
export function topicLabel(
  topics: readonly Pick<TopicLike, 'id' | 'name'>[],
  id: string | null,
  unsorted: string,
): string {
  return topicById(topics, id)?.name ?? unsorted;
}
