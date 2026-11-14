/** Freezes a value and everything it holds (a Date's own fields; its time stays its slot). */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/**
 * The root of every persisted class: its stored data is a private, deeply frozen copy, it is
 * known by its id, and two entities are equal when they are the same kind of thing with the same
 * id. Subclasses read the data through `this.data` and expose it through getters; nothing outside
 * the class can change it, at any depth.
 */
export abstract class Entity<TData extends { id: string }> {
  readonly #data: Readonly<TData>;

  protected constructor(data: TData) {
    this.#data = deepFreeze(structuredClone(data));
  }

  get id(): string {
    return this.#data.id;
  }

  /** The stored fields, read-only. */
  protected get data(): Readonly<TData> {
    return this.#data;
  }

  /** A deep copy of the stored fields: what the class was made from. */
  toJSON(): TData {
    return structuredClone(this.#data);
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
