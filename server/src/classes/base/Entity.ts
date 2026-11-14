/**
 * The root of every persisted class: its stored data is private and frozen, it is known by its
 * id, and two entities are equal when they are the same kind of thing with the same id.
 * Subclasses read the data through `this.data` and expose it through getters; nothing outside the
 * class can change it.
 */
export abstract class Entity<TData extends { id: string }> {
  readonly #data: Readonly<TData>;

  protected constructor(data: TData) {
    this.#data = Object.freeze({ ...data });
  }

  get id(): string {
    return this.#data.id;
  }

  /** The stored fields, read-only. */
  protected get data(): Readonly<TData> {
    return this.#data;
  }

  /** A copy of the stored fields: what the class was made from. */
  toJSON(): TData {
    return { ...this.#data };
  }

  /** Same class, same id: the same thing, whatever was loaded when. */
  equals(other: Entity<TData> | null | undefined): boolean {
    return (
      other !== null &&
      other !== undefined &&
      Object.getPrototypeOf(other) === Object.getPrototypeOf(this) &&
      other.id === this.id
    );
  }
}
