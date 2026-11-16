/** What a topic's rename field does on Enter or when focus leaves it. */
export type RenameStep = 'save' | 'close' | 'wait';

/**
 * A changed name is saved; an empty or unchanged one just closes the field. While a save is in
 * flight the field waits for it: the field is disabled then, and Chromium blurs a focused field
 * when it is disabled. Closing on that blur unmounted the field before the save answered, so its
 * "Renamed to" toast (or its error) never showed.
 */
export function renameStep(name: string, current: string, saving: boolean): RenameStep {
  if (saving) {
    return 'wait';
  }
  const trimmed = name.trim();
  return trimmed === '' || trimmed === current ? 'close' : 'save';
}
