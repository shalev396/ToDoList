/**
 * A member's travel rule (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Concepts", 3;
 * plan Ruling 11): "when [scope] → travel by [mode], [there / back / both]", optionally to one of
 * their places. Its scope is a where-group (checked like a dashboard query: 400 when it isn't one),
 * every occurrence of one series, or one item or occurrence. Rules are their member's only (another
 * member's rule is a 404); a member keeps at most PLAN_LIMITS.travelRulesPerMember (409
 * `travel_limit`). Changes are for editors and owners.
 *
 * Every change is audited (`travel_rule.create`, `.update`, `.delete`, Ruling 15) with exactly
 * `{ mode, direction, scopeKind }`: never a place, an address, a coordinate or the rule's text.
 * The member's profile notes whether they have travel at all (the daily pass reads that).
 */
import { parseQuery } from '../../builder/compile.js';
import { QueryValidationError } from '../../builder/errors.js';
import { AppError } from '../../errors/AppError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { ValidationError } from '../../errors/ValidationError.js';
import type { TravelRuleData, TravelRulePatch } from '../../models/definitions/TravelRule.js';
import { getTravelRuleRepository } from '../../models/index.js';
import { PLAN_LIMITS } from '../../types/limits.js';
import {
  RULE_DIRECTIONS,
  TRAVEL_MODES,
  type RuleDirection,
  type TravelMode,
  type TravelRuleScope,
  type TravelRuleScopeKind,
} from '../../types/travel.js';
import { AuditTarget } from '../base/AuditTarget.js';
import type { Caller } from '../base/Caller.js';
import type { Auditable, Owned } from '../base/contracts.js';
import { WorkspaceEntity } from '../base/WorkspaceEntity.js';
import { AuditLog } from '../AuditLog.js';
import { Place } from './Place.js';
import { TravelProfile } from './TravelProfile.js';

/** A new rule as callers give it. */
export interface NewTravelRule {
  scope: TravelRuleScope;
  mode: TravelMode;
  direction: RuleDirection;
  /** One of the caller's places; null or absent: the anchor's own place applies. */
  placeId?: string | null | undefined;
}

const ID_MAX = 200;

function oneOf<T extends string>(values: readonly T[], value: unknown, field: string): T {
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T;
  throw new ValidationError(`${field}: one of ${values.join(', ')}`);
}

function itemIdOf(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > ID_MAX) {
    throw new ValidationError('scope.itemId: an item id');
  }
  return value;
}

/** An occurrence: `single`, or its original start as an ISO instant (stored normalized). */
function occurrenceOf(value: unknown): string {
  if (value === 'single') return value;
  const instant = typeof value === 'string' ? new Date(value) : null;
  if (instant === null || Number.isNaN(instant.getTime())) {
    throw new ValidationError("scope.occurrence: 'single' or the occurrence's original start");
  }
  return instant.toISOString();
}

/** The scope as stored: a where-group the dashboards' compiler takes, or an item reference. */
function scopeOf(scope: TravelRuleScope): TravelRuleScope {
  switch (scope.kind) {
    case 'where':
      try {
        const query = parseQuery({ source: 'items', where: scope.where });
        if (query.where === undefined) throw new ValidationError('scope.where: a rule group');
        return { kind: 'where', where: query.where };
      } catch (error) {
        if (error instanceof QueryValidationError) {
          throw new ValidationError(`scope: ${error.message}`);
        }
        throw error;
      }
    case 'series':
      return { kind: 'series', itemId: itemIdOf(scope.itemId) };
    case 'item':
      return {
        kind: 'item',
        itemId: itemIdOf(scope.itemId),
        occurrence: occurrenceOf(scope.occurrence),
      };
    default:
      throw new ValidationError('scope.kind: one of where, series, item');
  }
}

export class TravelRule extends WorkspaceEntity<TravelRuleData> implements Owned, Auditable {
  /** The audit action names a rule writes. */
  static readonly Audit = Object.freeze({
    create: 'travel_rule.create',
    update: 'travel_rule.update',
    delete: 'travel_rule.delete',
  });

  private constructor(data: TravelRuleData) {
    super(data);
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /** The caller's rules, oldest first (where-rules apply in this order). */
  static async listOwn(caller: Caller): Promise<TravelRule[]> {
    const rows = await (await getTravelRuleRepository()).listOwn(caller.workspaceId, caller.userId);
    return rows.map((row) => new TravelRule(row));
  }

  /** The caller's rule with this id; 404 for anyone else's, or none. */
  static async findOwn(caller: Caller, id: string): Promise<TravelRule> {
    const row = await (
      await getTravelRuleRepository()
    ).findOwn(caller.workspaceId, caller.userId, id);
    if (row === null) throw new NotFoundError();
    return new TravelRule(row);
  }

  get ownerUserId(): string {
    return this.data.ownerUserId;
  }

  isOwnedBy(userId: string): boolean {
    return this.data.ownerUserId === userId;
  }

  get scope(): TravelRuleScope {
    return structuredClone(this.data.scope);
  }

  get scopeKind(): TravelRuleScopeKind {
    return this.data.scope.kind;
  }

  get mode(): TravelMode {
    return this.data.mode;
  }

  get direction(): RuleDirection {
    return this.data.direction;
  }

  /** The place it sends the member to; null: the anchor's own place. */
  get placeId(): string | null {
    return this.data.placeId;
  }

  get createdAt(): Date {
    return this.data.createdAt;
  }

  auditTarget(): AuditTarget {
    return AuditTarget.of('travel_rule', this.id);
  }

  // ─── Changes ──────────────────────────────────────────────────────────────

  /** Editors: a new rule of the caller's (400 for a scope that isn't one; 409 at the cap). */
  static async create(caller: Caller, input: NewTravelRule): Promise<TravelRule> {
    caller.require('editor');
    const scope = scopeOf(input.scope);
    const mode = oneOf(TRAVEL_MODES, input.mode, 'mode');
    const direction = oneOf(RULE_DIRECTIONS, input.direction, 'direction');
    const placeId = input.placeId ?? null;
    if (placeId !== null) await Place.assertOwn(caller, placeId);
    const rules = await getTravelRuleRepository();
    const count = await rules.countOwn(caller.workspaceId, caller.userId);
    if (count >= PLAN_LIMITS.travelRulesPerMember) {
      throw new AppError(409, 'You have the most travel rules allowed: remove one first', {
        code: 'travel_limit',
      });
    }
    const rule = new TravelRule(
      await rules.create(caller.workspaceId, {
        ownerUserId: caller.userId,
        scope,
        mode,
        direction,
        placeId,
      }),
    );
    await TravelProfile.noteRules(caller, true);
    await rule.#audit(caller, TravelRule.Audit.create);
    return rule;
  }

  /** Editors, on their own rule: a new scope, mode, direction or place (null: none). */
  async update(caller: Caller, patch: Partial<NewTravelRule>): Promise<TravelRule> {
    this.#authorize(caller);
    const change: TravelRulePatch = {};
    if (patch.scope !== undefined) change.scope = scopeOf(patch.scope);
    if (patch.mode !== undefined) change.mode = oneOf(TRAVEL_MODES, patch.mode, 'mode');
    if (patch.direction !== undefined) {
      change.direction = oneOf(RULE_DIRECTIONS, patch.direction, 'direction');
    }
    if (patch.placeId !== undefined) {
      if (patch.placeId !== null) await Place.assertOwn(caller, patch.placeId);
      change.placeId = patch.placeId;
    }
    const row = await (
      await getTravelRuleRepository()
    ).update(this.workspaceId, this.ownerUserId, this.id, change);
    if (row === null) throw new NotFoundError();
    const rule = new TravelRule(row);
    await rule.#audit(caller, TravelRule.Audit.update);
    return rule;
  }

  /** Editors, on their own rule: it goes. */
  async remove(caller: Caller): Promise<void> {
    this.#authorize(caller);
    const rules = await getTravelRuleRepository();
    if (!(await rules.delete(this.workspaceId, this.ownerUserId, this.id))) {
      throw new NotFoundError();
    }
    const left = await rules.countOwn(this.workspaceId, this.ownerUserId);
    await TravelProfile.noteRules(caller, left > 0);
    await this.#audit(caller, TravelRule.Audit.delete);
  }

  // ─── Inside ───────────────────────────────────────────────────────────────

  /** 404 unless it is the caller's own rule (here); then the editor check (403). */
  #authorize(caller: Caller): void {
    this.assertIn(caller);
    if (!this.isOwnedBy(caller.userId)) throw new NotFoundError();
    caller.require('editor');
  }

  /** The one audit shape of a rule: how and which way, and what kind of scope. Nothing else. */
  async #audit(caller: Caller, action: string): Promise<void> {
    await AuditLog.record(caller, action, this, {
      mode: this.mode,
      direction: this.direction,
      scopeKind: this.scopeKind,
    });
  }
}
