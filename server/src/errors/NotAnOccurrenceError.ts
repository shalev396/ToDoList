import { ValidationError } from './ValidationError.js';

/**
 * 400 `not_an_occurrence`: editing or skipping one occurrence of a time block at a start that is
 * not one of its series' slots (another time or day, before its first, after its last), or of a
 * block that does not repeat; and marking an occurrence of an item for travel at such a start
 * (`message` names the field: `occurrence: …`).
 */
export class NotAnOccurrenceError extends ValidationError {
  constructor(message = 'originalStart: not an occurrence of this time block') {
    super(message, { code: 'not_an_occurrence' });
    this.name = 'NotAnOccurrenceError';
  }
}
