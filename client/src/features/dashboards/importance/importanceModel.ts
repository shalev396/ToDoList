/**
 * The importance settings' state (H4): a page's preset and weights, with the defaults the server
 * uses when a page stores none. Pure, so the sliders' logic is tested without the UI.
 */
import type { AttributeDef } from '@api-types/attributes.ts';
import {
  DEFAULT_IMPORTANCE,
  DEFAULT_WEIGHTS,
  MAX_WEIGHT,
  WEIGHT_FACTORS,
  type ImportanceConfig,
  type ImportancePreset,
} from '@api-types/importance.ts';

/** The stored config, or Weighted with the defaults when the page has none. */
export function configOf(stored: ImportanceConfig | null | undefined): ImportanceConfig {
  return stored ?? DEFAULT_IMPORTANCE;
}

/** The custom attributes a weight can name: ratings and numbers. */
export function weightableAttributes(attributes: readonly AttributeDef[]): AttributeDef[] {
  return attributes.filter(
    (def) => !def.builtIn && (def.type === 'rating' || def.type === 'number'),
  );
}

/** Every weight shown: the built-in factors (default unless set), then each custom attribute (0). */
export function weightsShown(
  config: ImportanceConfig,
  attributes: readonly AttributeDef[],
): { key: string; weight: number; attribute?: AttributeDef }[] {
  const set = config.preset === 'weighted' ? (config.params.weights ?? {}) : {};
  return [
    ...WEIGHT_FACTORS.map((key) => ({
      key: key,
      weight: set[key] ?? DEFAULT_WEIGHTS[key],
    })),
    ...weightableAttributes(attributes).map((attribute) => ({
      key: `attr.${attribute.key}`,
      weight: set[`attr.${attribute.key}`] ?? 0,
      attribute,
    })),
  ];
}

/** Switches the preset. Weighted keeps its weights when coming back to it; the others have none. */
export function withPreset(
  preset: ImportancePreset,
  keptWeights: Record<string, number> | undefined,
): ImportanceConfig {
  if (preset === 'weighted') {
    return keptWeights === undefined
      ? { preset, params: {} }
      : { preset, params: { weights: keptWeights } };
  }
  return { preset, params: {} };
}

/** One weight changed (clamped to 0 to 10, whole numbers); the others are kept as shown. */
export function withWeight(
  config: ImportanceConfig,
  attributes: readonly AttributeDef[],
  key: string,
  weight: number,
): ImportanceConfig {
  const next: Record<string, number> = {};
  for (const shown of weightsShown(config, attributes)) {
    next[shown.key] = shown.key === key ? clampWeight(weight) : shown.weight;
  }
  return { preset: 'weighted', params: { weights: next } };
}

export function clampWeight(weight: number): number {
  return Math.min(MAX_WEIGHT, Math.max(0, Math.round(Number.isFinite(weight) ? weight : 0)));
}

/** True when the config is what a page without one would use (nothing to save). */
export function isDefaultConfig(
  config: ImportanceConfig,
  attributes: readonly AttributeDef[],
): boolean {
  if (config.preset !== 'weighted') {
    return false;
  }
  return weightsShown(config, attributes).every(
    ({ key, weight }) =>
      weight ===
      (key in DEFAULT_WEIGHTS ? DEFAULT_WEIGHTS[key as keyof typeof DEFAULT_WEIGHTS] : 0),
  );
}

/** What to store: nothing for the default, else the config (zero custom weights dropped). */
export function configToStore(
  config: ImportanceConfig,
  attributes: readonly AttributeDef[],
): ImportanceConfig | null {
  if (isDefaultConfig(config, attributes)) {
    return null;
  }
  if (config.preset !== 'weighted') {
    return config;
  }
  const weights: Record<string, number> = {};
  for (const { key, weight } of weightsShown(config, attributes)) {
    if (key in DEFAULT_WEIGHTS || weight > 0) {
      weights[key] = weight;
    }
  }
  return { preset: 'weighted', params: { weights } };
}
