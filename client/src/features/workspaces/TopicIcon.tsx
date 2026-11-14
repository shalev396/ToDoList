import type { TopicIcon as TopicIconName } from '@api-types/topics';
import { TOPIC_ICON_COMPONENTS } from '@/features/workspaces/topics';

/** A topic's icon; a folder for a topic without one. Decorative: the name is next to it. */
export function TopicIcon({ icon, className }: { icon: TopicIconName | null; className?: string }) {
  const Glyph = TOPIC_ICON_COMPONENTS[icon ?? 'folder'];
  return <Glyph className={className} aria-hidden="true" />;
}
