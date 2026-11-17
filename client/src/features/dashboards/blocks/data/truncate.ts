const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Cuts a title at `max` visible characters with an ellipsis, never inside an emoji or a combined
 * letter. Layout truncation is CSS (`truncate` + a `title`); this bounds what is put in the DOM
 * and in tooltips for 300-character titles.
 */
export function truncateText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const graphemes = Array.from(segmenter.segment(clean), (part) => part.segment);
  if (graphemes.length <= max) {
    return clean;
  }
  return `${graphemes
    .slice(0, Math.max(0, max - 1))
    .join('')
    .trimEnd()}…`;
}
