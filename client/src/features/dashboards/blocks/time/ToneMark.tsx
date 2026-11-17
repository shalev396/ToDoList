import { useTranslation } from 'react-i18next';
import { CircleAlert, CircleCheck, CircleMinus, TriangleAlert } from 'lucide-react';
import type { Tone } from '../../rules/applyDisplayRules';

const ICONS = {
  destructive: CircleAlert,
  warning: TriangleAlert,
  success: CircleCheck,
  muted: CircleMinus,
} as const;

/**
 * A display rule's tone as an icon plus a screen-reader label: status colour is never the only
 * signal (DESIGN.md "Status colours").
 */
export function ToneMark({ tone }: { tone: Tone }) {
  const { t } = useTranslation();
  const Icon = ICONS[tone];
  return (
    <>
      <Icon aria-hidden="true" className="size-3 shrink-0" data-tone={tone} />
      <span className="sr-only">{t(`timeBlocks.tone.${tone}`)}</span>
    </>
  );
}
