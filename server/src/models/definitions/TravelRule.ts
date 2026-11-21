import type {
  RuleDirection,
  RuleLengths,
  TravelMode,
  TravelRuleScope,
} from '../../types/travel.js';

/**
 * A member's travel rule (plan Ruling 11): "when [scope] → travel by [mode], [there / back / both]",
 * optionally to a place of theirs. Private to its member.
 */
export interface TravelRuleData {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  scope: TravelRuleScope;
  mode: TravelMode;
  direction: RuleDirection;
  /** One of the member's places; null: the anchor's own place applies. */
  placeId: string | null;
  /** Whole minutes the "there" leg arrives early; null: 0. Rules stored before it read as null. */
  arriveEarlyMinutes: number | null;
  /** Lengths that win over the trip's own for the legs it draws; null: none. */
  lengths: RuleLengths | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewTravelRuleRecord {
  ownerUserId: string;
  scope: TravelRuleScope;
  mode: TravelMode;
  direction: RuleDirection;
  placeId: string | null;
  arriveEarlyMinutes: number | null;
  lengths: RuleLengths | null;
}

export interface TravelRulePatch {
  scope?: TravelRuleScope;
  mode?: TravelMode;
  direction?: RuleDirection;
  placeId?: string | null;
  arriveEarlyMinutes?: number | null;
  lengths?: RuleLengths | null;
}

export interface ITravelRuleRepository {
  create(workspaceId: string, input: NewTravelRuleRecord): Promise<TravelRuleData>;
  /** The owner's rule with this id; null for anyone else's, or none. */
  findOwn(workspaceId: string, ownerUserId: string, id: string): Promise<TravelRuleData | null>;
  /** The owner's rules, oldest first (where-rules apply in this order). */
  listOwn(workspaceId: string, ownerUserId: string): Promise<TravelRuleData[]>;
  countOwn(workspaceId: string, ownerUserId: string): Promise<number>;
  /** Null when the owner has no such rule. */
  update(
    workspaceId: string,
    ownerUserId: string,
    id: string,
    patch: TravelRulePatch,
  ): Promise<TravelRuleData | null>;
  /** Hard delete. False when there was nothing to delete. */
  delete(workspaceId: string, ownerUserId: string, id: string): Promise<boolean>;
  /** A place was removed: the owner's rules naming it name none. Returns how many. */
  clearPlace(workspaceId: string, ownerUserId: string, placeId: string): Promise<number>;
  /** Containers were removed: the repeats rules of these calendars or projects go. How many. */
  deleteRepeatsIn(workspaceId: string, containerIds: readonly string[]): Promise<number>;
  /** A membership ended: every rule of the member, hard-deleted. Returns how many. */
  deleteForMember(workspaceId: string, ownerUserId: string): Promise<number>;
  /** The workspace was deleted: every rule in it. Returns how many. */
  deleteForWorkspace(workspaceId: string): Promise<number>;
}

export const TRAVEL_RULE_TABLE_NAME = 'TravelRules';
