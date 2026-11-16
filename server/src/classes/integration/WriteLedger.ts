/**
 * The provider calls of one write-back that went through (plan Addendum A1). Each is audited the
 * moment it succeeds (`integration.write`, field names only), never only at the end, and what it
 * confirmed is kept for the save. So a write-back that stops part-way (Jira's fields taken, its
 * transition refused; a save that fails afterwards) has still audited, and can still save, what
 * reached the provider. It holds no credential and sends nothing.
 */
import type { MirroredItemPatch } from '../../models/definitions/Item.js';
import type { WritableField } from '../../types/integrations.js';

export class WriteLedger {
  readonly #record: (fields: readonly WritableField[]) => Promise<void>;
  readonly #fields: WritableField[] = [];
  #values: MirroredItemPatch = {};

  /** `record` audits one provider call that went through, by the fields it wrote. */
  constructor(record: (fields: readonly WritableField[]) => Promise<void>) {
    this.#record = record;
  }

  /** One provider call went through: what it confirmed is kept, and it is audited now. */
  async confirm(fields: readonly WritableField[], values: MirroredItemPatch): Promise<void> {
    this.#fields.push(...fields);
    this.#values = { ...this.#values, ...values };
    await this.#record(fields);
  }

  /** What reached the provider so far, by name. */
  get fields(): readonly WritableField[] {
    return [...this.#fields];
  }

  /** What the provider confirmed so far, as the item's fields. */
  get values(): Readonly<MirroredItemPatch> {
    return { ...this.#values };
  }

  /** Nothing reached the provider. */
  get isEmpty(): boolean {
    return this.#fields.length === 0;
  }
}
