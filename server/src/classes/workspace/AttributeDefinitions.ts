/**
 * The definitions of a workspace's custom attributes (H4), the built-in Importance first (implied
 * for a workspace stored before attributes), as one immutable value object over an
 * `AttributeDefinition` per attribute. An item's values are checked against them by
 * AttributeValues (classes/item/AttributeValues.ts).
 */
import { BUILTIN_IMPORTANCE, type AttributeDef } from '../../types/attributes.js';
import { AttributeDefinition } from './AttributeDefinition.js';

export class AttributeDefinitions {
  readonly #list: readonly AttributeDefinition[];

  private constructor(list: readonly AttributeDefinition[]) {
    this.#list = Object.freeze([...list]);
    Object.freeze(this);
  }

  /** The definitions in a workspace's settings (anything with the stored `attributes`). */
  static of(settings: {
    readonly attributes?: readonly AttributeDef[] | undefined;
  }): AttributeDefinitions {
    const stored = settings.attributes ?? [];
    const withBuiltIn = stored.some((def) => def.key === BUILTIN_IMPORTANCE.key)
      ? stored
      : [{ ...BUILTIN_IMPORTANCE }, ...stored];
    return new AttributeDefinitions(withBuiltIn.map((def) => AttributeDefinition.of(def)));
  }

  get size(): number {
    return this.#list.length;
  }

  list(): readonly AttributeDefinition[] {
    return this.#list;
  }

  find(key: string): AttributeDefinition | undefined {
    return this.#list.find((definition) => definition.key === key);
  }

  toJSON(): AttributeDef[] {
    return this.#list.map((definition) => definition.toJSON());
  }
}
