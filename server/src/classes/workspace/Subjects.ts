/**
 * The workspace's subjects (each lesson its own colour): the options of the `subject` select and
 * the look each carries (a colour family and the title globs that pick it), as an immutable value
 * object. It decides how options gain families ("saved when assigned"), and how a subject is
 * renamed, restyled or appended; Workspace writes the result.
 */
import { AppError } from '../../errors/AppError.js';
import {
  MAX_ATTRIBUTE_OPTIONS,
  OptionLookSchema,
  type AttributeDef,
  type OptionLook,
} from '../../types/attributes.js';
import { nextFamily, subjectsOf, type ColourSubject } from '../../types/colours.js';
import type { TopicColour } from '../../types/topics.js';

export interface SubjectInput {
  /** The subject to change or append; with `rename`, the existing one to rename. */
  name: string;
  rename?: string | undefined;
  family?: TopicColour | undefined;
  patterns?: readonly string[] | undefined;
  /** What a first subject names the attribute (default "Subject"). */
  attributeName?: string | undefined;
}

export class Subjects {
  readonly #options: readonly string[];
  readonly #looks: readonly OptionLook[];

  private constructor(options: readonly string[], looks: readonly OptionLook[]) {
    this.#options = Object.freeze([...options]);
    this.#looks = Object.freeze(looks.map((look) => Object.freeze({ ...look })));
    Object.freeze(this);
  }

  /** The subjects of a stored `subject` definition (none when it is absent or not a select). */
  static of(def: AttributeDef | undefined): Subjects {
    if (def?.type !== 'select') return new Subjects([], []);
    const options = [...new Set(def.options ?? [])];
    const looks = (def.optionLooks ?? []).filter((look) => options.includes(look.option));
    return new Subjects(options, looks);
  }

  /** The options that have a look, in option order. */
  get list(): readonly ColourSubject[] {
    return subjectsOf([
      {
        key: 'subject',
        name: 'Subject',
        type: 'select',
        options: [...this.#options],
        optionLooks: [...this.#looks],
        builtIn: false,
      },
    ]);
  }

  get options(): readonly string[] {
    return this.#options;
  }

  /**
   * The option a typed name stands for, whatever its case or the spaces around it ("math " is
   * "Math"); undefined when there is none.
   */
  named(name: string): string | undefined {
    const wanted = Subjects.#folded(name);
    return this.#options.find((option) => Subjects.#folded(option) === wanted);
  }

  static #folded(name: string): string {
    return name.trim().normalize('NFC').toLowerCase();
  }

  /** Every option without a look gets the next family the topics and subjects so far leave. */
  complete(topicFamilies: readonly (TopicColour | null)[]): Subjects {
    const taken: (TopicColour | null)[] = [
      ...topicFamilies,
      ...this.#looks.map((look) => look.colour),
    ];
    const looks = new Map(this.#looks.map((look) => [look.option, look]));
    const completed: OptionLook[] = [];
    for (const option of this.#options) {
      const existing = looks.get(option);
      if (existing !== undefined) {
        completed.push(existing);
        continue;
      }
      const colour = nextFamily(taken);
      taken.push(colour);
      completed.push({ option, colour, patterns: [] });
    }
    return new Subjects(this.#options, completed);
  }

  /** Renames, restyles or appends one subject (400 past the option limit or on a bad look). */
  upsert(input: SubjectInput, topicFamilies: readonly (TopicColour | null)[]): Subjects {
    const base = this.complete(topicFamilies);
    const name = input.name.trim();
    const target = input.rename?.trim() ?? name;
    const found = base.#looks.find((look) => look.option === name);
    if (input.rename !== undefined && found === undefined) {
      throw new AppError(400, 'There is no such subject to rename');
    }
    if (target !== name && base.#options.includes(target)) {
      throw new AppError(400, 'A subject with that name exists');
    }
    if (found === undefined && base.#options.length >= MAX_ATTRIBUTE_OPTIONS) {
      throw new AppError(400, `At most ${String(MAX_ATTRIBUTE_OPTIONS)} subjects`);
    }
    const colour =
      input.family ??
      found?.colour ??
      nextFamily([...topicFamilies, ...base.#looks.map((look) => look.colour)]);
    const look = OptionLookSchema.safeParse({
      option: target,
      colour,
      patterns: input.patterns === undefined ? (found?.patterns ?? []) : [...input.patterns],
    });
    if (!look.success) throw new AppError(400, 'Invalid subject');
    if (found === undefined) {
      return new Subjects([...base.#options, target], [...base.#looks, look.data]);
    }
    return new Subjects(
      base.#options.map((option) => (option === name ? target : option)),
      base.#looks.map((entry) => (entry === found ? look.data : entry)),
    );
  }

  toDefinition(): { options: string[]; optionLooks: OptionLook[] } {
    return {
      options: [...this.#options],
      optionLooks: this.#looks.map((look) => ({ ...look, patterns: [...look.patterns] })),
    };
  }
}
