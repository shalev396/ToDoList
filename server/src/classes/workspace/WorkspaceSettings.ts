/**
 * A workspace's settings (DATA.md §3.2) as an immutable value object: its time zone, the first day
 * of the week, whether agents may publish, its topic rules and its attribute definitions. The
 * stored data is kept as it came (so `toJSON` is exactly what the repository holds); the rules and
 * definitions are value objects of their own.
 */
import { AppError } from '../../errors/AppError.js';
import type {
  TopicRule,
  WeekStart,
  WorkspaceSettings as WorkspaceSettingsData,
} from '../../models/definitions/Workspace.js';
import { canonicalTimeZone } from '../../utils/timeZone.js';
import { AttributeDefinitions } from './AttributeDefinitions.js';
import { TopicRules } from './TopicRules.js';

/** What an owner may change: only the settings given change; topic rules are replaced whole. */
export interface SettingsInput {
  timezone?: string | undefined;
  weekStart?: WeekStart | undefined;
  topicRules?: readonly TopicRule[] | undefined;
  /** Agent keys with builder:publish may publish dashboards. */
  allowAgentPublish?: boolean | undefined;
}

export class WorkspaceSettings {
  readonly #data: Readonly<WorkspaceSettingsData>;
  readonly #topicRules: TopicRules;
  readonly #attributes: AttributeDefinitions;

  private constructor(data: WorkspaceSettingsData) {
    this.#data = Object.freeze(structuredClone(data));
    this.#topicRules = TopicRules.of(data.topicRules);
    this.#attributes = AttributeDefinitions.of(data);
    Object.freeze(this);
  }

  static from(data: WorkspaceSettingsData): WorkspaceSettings {
    return new WorkspaceSettings(data);
  }

  /** The canonical IANA name of a time zone (any case); 400 when it is not one. */
  static normalizeTimeZone(timezone: string): string {
    const canonical = canonicalTimeZone(timezone);
    if (canonical === null) throw new AppError(400, 'timezone must be a valid IANA time zone');
    return canonical;
  }

  /** The stored patch of a request: each setting given, checked (the rules are validated whole). */
  static patchOf(input: SettingsInput): Partial<WorkspaceSettingsData> {
    const settings: Partial<WorkspaceSettingsData> = {};
    if (input.timezone !== undefined) {
      settings.timezone = WorkspaceSettings.normalizeTimeZone(input.timezone);
    }
    if (input.weekStart !== undefined) settings.weekStart = input.weekStart;
    if (input.topicRules !== undefined) {
      settings.topicRules = TopicRules.normalize(input.topicRules).toJSON();
    }
    if (input.allowAgentPublish !== undefined) settings.allowAgentPublish = input.allowAgentPublish;
    return settings;
  }

  get timezone(): string {
    return this.#data.timezone;
  }

  get weekStart(): WeekStart {
    return this.#data.weekStart;
  }

  get allowAgentPublish(): boolean {
    return this.#data.allowAgentPublish ?? false;
  }

  get topicRules(): TopicRules {
    return this.#topicRules;
  }

  get attributes(): AttributeDefinitions {
    return this.#attributes;
  }

  /** The settings as stored: a deep copy. */
  toJSON(): WorkspaceSettingsData {
    return structuredClone(this.#data);
  }
}
