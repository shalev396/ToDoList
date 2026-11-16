import type { Tone } from '../../rules/applyDisplayRules';

/** The accent a display rule's tone puts at the start of a row; a screen reader hears the tone. */
export const TONE_CLASS: Record<Tone, string> = {
  destructive: 'border-status-critical',
  warning: 'border-status-warning',
  success: 'border-status-good',
  muted: 'border-border',
};
