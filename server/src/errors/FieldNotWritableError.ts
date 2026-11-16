import type { Provider } from '../types/domain.js';
import { AppError } from './AppError.js';

/**
 * 422 `field_not_writable`: a write-back changes a field the provider doesn't take for this item:
 * it lacks the field (Jira's start date), holds it but TodoList can't write it (GitHub's due date
 * from a board), the item's kind takes no write-back (a pull request), or the field isn't on the
 * item's edit screen there. Nothing was opened or sent. `openIn` is where it can be changed.
 */
export class FieldNotWritableError extends AppError {
  readonly provider: string;
  /** Our names of the fields refused (the Item model's), never their values. */
  readonly fields: readonly string[];
  readonly openIn: { readonly provider: Provider; readonly url: string } | null;

  constructor(
    provider: string,
    fields: readonly string[],
    openIn: { provider: Provider; url: string } | null = null,
  ) {
    super(422, `${provider} doesn't take ${fields.join(', ')} for this item`, {
      code: 'field_not_writable',
    });
    this.name = 'FieldNotWritableError';
    this.provider = provider;
    this.fields = Object.freeze([...fields]);
    this.openIn = openIn === null ? null : Object.freeze({ ...openIn });
  }
}
