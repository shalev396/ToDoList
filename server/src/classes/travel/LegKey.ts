/**
 * A travel leg's key (plan Ruling 9): `ownerUserId|anchorItemId|occurrence|direction`. One leg per
 * member, anchor, occurrence and direction, so two members of a workspace going to one shared
 * lecture each get their own legs.
 *
 * `occurrence` is the anchor occurrence's ORIGINAL start (ISO): the slot it fills in its series,
 * which doesn't change when that one occurrence is moved. It is `single` for an item that doesn't
 * repeat. Regeneration upserts by this key (stored at `props.travelKey`), so running it twice
 * changes nothing. An immutable value object.
 */
import { TRAVEL_DIRECTIONS, type TravelDirection } from '../../types/travel.js';

const SEPARATOR = '|';

interface LegKeyParts {
  ownerUserId: string;
  anchorItemId: string;
  occurrence: string;
  direction: TravelDirection;
}

/** A part the key can carry: some text, without the separator. */
const isPart = (text: string): boolean => text !== '' && !text.includes(SEPARATOR);

const isDirection = (text: string): text is TravelDirection =>
  (TRAVEL_DIRECTIONS as readonly string[]).includes(text);

export class LegKey {
  readonly ownerUserId: string;
  readonly anchorItemId: string;
  readonly occurrence: string;
  readonly direction: TravelDirection;

  private constructor(parts: LegKeyParts) {
    this.ownerUserId = parts.ownerUserId;
    this.anchorItemId = parts.anchorItemId;
    this.occurrence = parts.occurrence;
    this.direction = parts.direction;
    Object.freeze(this);
  }

  /** The key of one member's leg to one anchor occurrence (throws on an empty part or a `|`). */
  static of(parts: LegKeyParts): LegKey {
    const { ownerUserId, anchorItemId, occurrence, direction } = parts;
    if (![ownerUserId, anchorItemId, occurrence].every(isPart) || !isDirection(direction)) {
      throw new Error('LegKey: each part must be non-empty text without "|"');
    }
    return new LegKey({ ownerUserId, anchorItemId, occurrence, direction });
  }

  /** A stored key read back (throws when the text is not one). */
  static parse(text: string): LegKey {
    const key = LegKey.tryParse(text);
    if (key === null) throw new Error('LegKey: not a travel leg key');
    return key;
  }

  /** A stored key read back, or null when the text is not one. */
  static tryParse(text: string): LegKey | null {
    const [ownerUserId, anchorItemId, occurrence, direction, ...rest] = text.split(SEPARATOR);
    if (
      rest.length > 0 ||
      ownerUserId === undefined ||
      anchorItemId === undefined ||
      occurrence === undefined ||
      direction === undefined ||
      ![ownerUserId, anchorItemId, occurrence].every(isPart) ||
      !isDirection(direction)
    ) {
      return null;
    }
    return new LegKey({ ownerUserId, anchorItemId, occurrence, direction });
  }

  /** The anchor occurrence it serves, `anchorItemId|occurrence`: what an anchor's fate is keyed by. */
  get anchorKey(): string {
    return `${this.anchorItemId}${SEPARATOR}${this.occurrence}`;
  }

  toString(): string {
    return [this.ownerUserId, this.anchorItemId, this.occurrence, this.direction].join(SEPARATOR);
  }

  equals(other: LegKey): boolean {
    return this.toString() === other.toString();
  }
}
