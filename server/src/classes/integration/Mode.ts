import { INTEGRATION_MODES, type IntegrationMode } from '../../types/domain.js';

/**
 * Whether TodoList may change anything at an integration's provider (value object):
 * - `read`, the default of every new connection: nothing is ever created, pushed or changed there;
 * - `read_write`, its owner's switch: creating to-dos there and pushing to Google Calendar.
 *
 * Immutable, one instance per mode, so modes compare by value. Integration#withWriteSession is
 * the one place that reads `allowsWrites`.
 */
export class Mode {
  static readonly read = new Mode('read');
  static readonly readWrite = new Mode('read_write');

  readonly #name: IntegrationMode;

  private constructor(name: IntegrationMode) {
    this.#name = name;
    Object.freeze(this);
  }

  /** The mode by name (a Mode is returned as it is); a stored value outside the modes throws. */
  static of(mode: Mode | IntegrationMode): Mode {
    if (mode instanceof Mode) return mode;
    switch (mode) {
      case 'read':
        return Mode.read;
      case 'read_write':
        return Mode.readWrite;
      default:
        throw new Error(`Unknown integration mode: ${JSON.stringify(mode)}`);
    }
  }

  /** The mode a received value names; null for anything else. */
  static parse(value: unknown): Mode | null {
    return typeof value === 'string' && (INTEGRATION_MODES as readonly string[]).includes(value)
      ? Mode.of(value as IntegrationMode)
      : null;
  }

  get name(): IntegrationMode {
    return this.#name;
  }

  /** Read & write: the provider may be changed (a create, a push). */
  get allowsWrites(): boolean {
    return this.#name === 'read_write';
  }

  equals(other: Mode | IntegrationMode): boolean {
    return Mode.of(other) === this;
  }

  toString(): IntegrationMode {
    return this.#name;
  }

  toJSON(): IntegrationMode {
    return this.#name;
  }
}
