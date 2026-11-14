/**
 * Builder ops (BUILDER.md §6 and §9, MCP.md §8): the named edits the UI editor and AI agents make
 * to a dashboard draft. Pure: no I/O and no clock; block ids and templates come from the caller.
 *
 * applyOps() applies the ops in order to a copy of the draft, validates the result as a whole
 * (validate.ts: schema, caps, catalog, compiler, safety) and returns it with the RFC 6902 patch from
 * the input to the result and the inverse patch. The input is never modified, even when an op fails.
 */
import { randomInt } from 'node:crypto';
import { createPatch, type Operation } from 'rfc6902';

import {
  OpSchema,
  CAPS,
  VAR_REF_PATTERN,
  VIEW_BLOCK_TYPE,
  isRigidViewType,
  VAR_REF_PREFIX,
  type Block,
  type DashboardDraft,
  type DashboardVars,
  type GridPos,
  type LayoutItem,
  type Layouts,
  type PageView,
  type ViewConfig,
  type ViewType,
  type Op,
  type Operator,
  type Query,
  type Rule,
  type RuleGroup,
} from '../types/builder.js';
import { BLOCK_CATALOG, lookupField, type FieldSpec, type GridSize } from './catalog.js';
import { assertSafeInput } from './compile.js';
import { OpValidationError, QueryValidationError, fromZodError } from './errors.js';
import { checkDraft } from './validate.js';

/** One RFC 6902 operation, as stored in DashboardVersions. */
export type PatchOperation = Operation;

export const BREAKPOINTS = ['lg', 'md', 'sm'] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/** Grid columns per breakpoint (react-grid-layout `cols`): what auto-placement fills. */
export const GRID_COLUMNS: Readonly<Record<Breakpoint, number>> = { lg: 12, md: 8, sm: 1 };

/** A template's localized draft for `key` (its block ids are replaced), or null when unknown. */
export type TemplateLookup = (key: string) => DashboardDraft | null;

/** A view template in one language: the view's type and title, its blocks and (dashboard) layouts. */
export interface ViewTemplateDraft {
  key: string;
  type: ViewType;
  title: string;
  vars: DashboardVars;
  blocks: Block[];
  layouts: Layouts;
}

/** A view template's localized, connector-bound draft for `key`, or null when unknown. */
export type ViewTemplateLookup = (key: string) => ViewTemplateDraft | null;

export interface ApplyOpsContext {
  /** A fresh block id (`newBlockId`); ids already on the dashboard are skipped. */
  newBlockId: () => string;
  templates: TemplateLookup;
  /** add_view with a templateKey; without it every key is unknown. */
  viewTemplates?: ViewTemplateLookup;
  /** A fresh view id (`newViewId`); ids already on the dashboard are skipped. */
  newViewId?: () => string;
}

export interface ApplyOpsResult {
  next: DashboardDraft;
  /** RFC 6902: turns the input draft into `next`. */
  patch: PatchOperation[];
  /** RFC 6902: turns `next` back into the input draft. */
  inverse: PatchOperation[];
  /** Things worth telling the editor that are not errors (e.g. a variable nothing sets any more). */
  warnings: string[];
}

type OpOf<K extends Op['op']> = Extract<Op, { op: K }>;
type Position = Omit<LayoutItem, 'i'>;

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 10;
const MAX_ID_ATTEMPTS = 100;
const MAX_SUMMARY = 200;

/** `blk_` and 10 random lowercase letters or digits. */
export function newBlockId(): string {
  let id = 'blk_';
  for (let index = 0; index < ID_LENGTH; index += 1) {
    id += ID_ALPHABET.charAt(randomInt(ID_ALPHABET.length));
  }
  return id;
}

/** `vw_` and 10 random lowercase letters or digits. */
export function newViewId(): string {
  let id = 'vw_';
  for (let index = 0; index < ID_LENGTH; index += 1) {
    id += ID_ALPHABET.charAt(randomInt(ID_ALPHABET.length));
  }
  return id;
}

/** A JSON copy: detached from its source, without undefined members (as the database stores it). */
function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** The row just below every item. */
function bottom(items: readonly LayoutItem[]): number {
  return items.reduce((lowest, item) => Math.max(lowest, item.y + item.h), 0);
}

function overlaps(a: Position, b: Position): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The first free slot for `size`, scanning rows top to bottom and each row left to right. */
function firstFreeSlot(items: readonly LayoutItem[], cols: number, size: GridSize): Position {
  const w = Math.min(Math.max(size.w, 1), cols);
  const last = bottom(items);
  for (let y = 0; y < last; y += 1) {
    for (let x = 0; x + w <= cols; x += 1) {
      const candidate = { x, y, w, h: size.h };
      if (!items.some((item) => overlaps(item, candidate))) return candidate;
    }
  }
  return { x: 0, y: last, w, h: size.h };
}

/** An lg width (12 columns) on a grid of `cols` columns: rounded, at least 1. */
function scaleWidth(w: number, cols: number): number {
  return Math.min(cols, Math.max(1, Math.round((w * cols) / GRID_COLUMNS.lg)));
}

function position({ x, y, w, h }: GridPos): Position {
  return { x, y, w, h };
}

/** A copy of the draft whose blocks have fresh ids, its layouts following them. */
export function remapBlockIds(draft: DashboardDraft, nextId: () => string): DashboardDraft {
  const ids = new Map<string, string>();
  const blocks = draft.blocks.map((block) => {
    const id = nextId();
    ids.set(block.id, id);
    return { ...block, id };
  });
  const remap = (items: readonly LayoutItem[]): LayoutItem[] =>
    items.flatMap((item) => {
      const id = ids.get(item.i);
      return id === undefined ? [] : [{ ...item, i: id }];
    });
  return {
    ...draft,
    blocks,
    layouts: {
      lg: remap(draft.layouts.lg),
      md: remap(draft.layouts.md),
      sm: remap(draft.layouts.sm),
    },
  };
}

/**
 * The operator a variable binds with, or null when the field can't take what the source sets. A
 * list (a multi-select filter, or a variable whose value is a list) binds with `in`, on fields
 * that take it; a date field takes one range (`within`); a list field one element (`contains`);
 * anything else `=`.
 */
function bindingOperator(spec: FieldSpec, list: boolean): Operator | null {
  if (spec.type === 'date') return list ? null : 'within';
  if (list) return spec.operators.includes('in') ? 'in' : null;
  return spec.type === 'array' ? 'contains' : '=';
}

/** A top-level rule on `field` whose value is a `$page` variable: a binding, not a static rule. */
function isBinding(node: Rule | RuleGroup, field: string): node is Rule {
  return (
    !('combinator' in node) &&
    node.field === field &&
    typeof node.value === 'string' &&
    VAR_REF_PATTERN.test(node.value)
  );
}

/**
 * `where` with the binding: it replaces the top-level rules on its field that bind a `$page`
 * variable (and only those: a static rule such as `status in [open, in_progress]` stays). A group
 * that is not a plain `and` (an `or`, or a negated `and`) is wrapped in an `and` with the binding,
 * so the binding always applies as is. Also returns the variables it replaced.
 */
function bindRule(
  where: RuleGroup | undefined,
  rule: Rule,
): { where: RuleGroup; replaced: string[] } {
  if (where === undefined) return { where: { combinator: 'and', rules: [rule] }, replaced: [] };
  if (where.combinator !== 'and' || where.not === true) {
    return { where: { combinator: 'and', rules: [where, rule] }, replaced: [] };
  }
  const rules: RuleGroup['rules'] = [];
  const replaced: string[] = [];
  let placed = false;
  for (const node of where.rules) {
    if (!isBinding(node, rule.field)) {
      rules.push(node);
      continue;
    }
    replaced.push(String(node.value));
    if (!placed) {
      rules.push(rule);
      placed = true;
    }
  }
  if (!placed) rules.push(rule);
  return { where: { ...where, rules }, replaced };
}

/** The `$page` variables a query reads: rule values at any depth, and the dateRange. */
function variablesRead(query: Query): Set<string> {
  const read = new Set<string>();
  const visit = (group: RuleGroup): void => {
    for (const node of group.rules) {
      if ('combinator' in node) visit(node);
      else if (typeof node.value === 'string' && VAR_REF_PATTERN.test(node.value)) {
        read.add(node.value);
      }
    }
  };
  if (query.where !== undefined) visit(query.where);
  if (typeof query.dateRange === 'string' && VAR_REF_PATTERN.test(query.dateRange)) {
    read.add(query.dateRange);
  }
  return read;
}

/** The field a chart or filter block filters on: the filter's `viz.field`, the chart's groupBy. */
function boundField(source: Block): string | undefined {
  if (source.type === 'filter') {
    const field = source.viz['field'];
    return typeof field === 'string' ? field : undefined;
  }
  return source.query?.groupBy?.[0];
}

/** Viz patches merge like a JSON Merge Patch: given keys replace, `null` removes a key. */
function mergeViz(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({ ...current, ...patch }).filter(([, value]) => value !== null),
  );
}

/** The variables a block sets: a filter's `sets`, a chart's `emits`. */
function variablesSetBy(block: Block): string[] {
  return [block.sets, block.emits?.onSegmentClick, block.emits?.onSelect].filter(
    (variable): variable is string => variable !== undefined,
  );
}

/** Applies ops to a private copy of a draft. */
class Editor {
  readonly warnings: string[] = [];
  private readonly taken: Set<string>;
  readonly state: DashboardDraft;
  private readonly ctx: ApplyOpsContext;

  constructor(state: DashboardDraft, ctx: ApplyOpsContext) {
    this.state = state;
    this.ctx = ctx;
    this.taken = new Set(state.blocks.map((block) => block.id));
  }

  apply(op: Op, pointer: string): void {
    switch (op.op) {
      case 'add_block':
        this.addBlock(op);
        return;
      case 'update_block':
        this.updateBlock(op, pointer);
        return;
      case 'remove_block':
        this.removeBlock(op, pointer);
        return;
      case 'arrange':
        this.arrange(op, pointer);
        return;
      case 'connect_blocks':
        this.connectBlocks(op, pointer);
        return;
      case 'apply_template':
        this.applyTemplate(op, pointer);
        return;
      case 'set_view':
        this.setView(op, pointer);
        return;
      case 'add_view':
        this.addView(op, pointer);
        return;
      case 'update_view':
        this.viewAt(op.viewId, `${pointer}/viewId`).title = op.title;
        return;
      case 'remove_view':
        this.removeView(op, pointer);
        return;
      case 'move_view':
        this.moveView(op, pointer);
        return;
      case 'set_title':
        this.state.title = op.title;
        return;
      case 'set_vars':
        this.state.vars = { ...op.vars };
        return;
      case 'set_importance':
        if (op.importance === null) Reflect.deleteProperty(this.state, 'importance');
        else this.state.importance = structuredClone(op.importance);
        return;
    }
  }

  private freshId(): string {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = this.ctx.newBlockId();
      if (!this.taken.has(id)) {
        this.taken.add(id);
        return id;
      }
    }
    throw new Error('newBlockId keeps returning ids that are taken');
  }

  private indexOf(id: string, pointer: string): number {
    const index = this.state.blocks.findIndex((block) => block.id === id);
    if (index === -1) throw new OpValidationError(pointer, 'no block with this id');
    return index;
  }

  private blockAt(index: number): Block {
    const block = this.state.blocks[index];
    if (block === undefined) throw new Error(`no block at ${String(index)}`);
    return block;
  }

  private addBlock(op: OpOf<'add_block'>): void {
    const entry = BLOCK_CATALOG[op.block.type];
    const defaults = structuredClone(entry.defaults);
    const { viz, ...given } = op.block;
    // A block bound to a saved view runs the view: a default query would shadow it.
    const { query: defaultQuery, ...otherDefaults } = defaults;
    const boundToView = (given.savedViewId ?? null) !== null && given.query === undefined;
    const id = this.freshId();
    const block = {
      id,
      title: '',
      ...otherDefaults,
      ...(boundToView || defaultQuery === undefined ? {} : { query: defaultQuery }),
      ...given,
      viz: { ...defaults.viz, ...viz },
    } as Block;
    const view = op.viewId === undefined ? null : this.viewAt(op.viewId, '/viewId');
    if (view !== null && isRigidViewType(view.type)) {
      throw new OpValidationError('/viewId', `a ${view.type} view is one block: it has no grid`);
    }
    this.state.blocks.push(block);
    view?.blockIds.push(id);
    this.place(id, entry.size, op.layout, view);
  }

  private viewAt(id: string, pointer: string): PageView {
    const view = this.state.views?.find((entry) => entry.id === id);
    if (view === undefined) throw new OpValidationError(pointer, 'no view with this id');
    return view;
  }

  /** The layout items of one grid: a view's blocks, or (no view) the Summary's. */
  private gridItems(bp: Breakpoint, view: PageView | null): LayoutItem[] {
    const inViews = new Set((this.state.views ?? []).flatMap((entry) => entry.blockIds));
    const mine = new Set(view?.blockIds ?? []);
    return this.state.layouts[bp].filter((item) =>
      view === null ? !inViews.has(item.i) : mine.has(item.i),
    );
  }

  /**
   * Layout entries for a new block. A breakpoint without a given position is auto-placed: lg in
   * the first free slot (the catalog size), md the same on 8 columns with the width scaled, sm at
   * the end of its single column. md and sm take their size from lg.
   */
  private place(
    id: string,
    size: GridSize,
    given: OpOf<'add_block'>['layout'],
    view: PageView | null = null,
  ): void {
    const { layouts } = this.state;
    const grid = (bp: Breakpoint): LayoutItem[] => this.gridItems(bp, view);
    const lg = given?.lg ? position(given.lg) : firstFreeSlot(grid('lg'), GRID_COLUMNS.lg, size);
    const scaled = { w: scaleWidth(lg.w, GRID_COLUMNS.md), h: lg.h };
    const md = given?.md ? position(given.md) : firstFreeSlot(grid('md'), GRID_COLUMNS.md, scaled);
    const sm = given?.sm ? position(given.sm) : { x: 0, y: bottom(grid('sm')), w: 1, h: lg.h };
    layouts.lg.push({ i: id, ...lg });
    layouts.md.push({ i: id, ...md });
    layouts.sm.push({ i: id, ...sm });
  }

  private updateBlock(op: OpOf<'update_block'>, pointer: string): void {
    const index = this.indexOf(op.blockId, `${pointer}/blockId`);
    const current = this.blockAt(index);
    const { viz, connectors, ...fields } = op.patch;
    const next: Record<string, unknown> = { ...current, ...fields };
    if (viz !== undefined) next['viz'] = mergeViz(current.viz, viz);
    // null: no connectors field, so the block reads every source its viewer may see.
    if (connectors === null) delete next['connectors'];
    else if (connectors !== undefined) next['connectors'] = connectors;
    // Any edit ends the block's "A source was removed" notice (set by Stop sharing).
    delete next['sourceRemoved'];
    this.state.blocks[index] = next as Block;
  }

  private removeBlock(op: OpOf<'remove_block'>, pointer: string): void {
    const index = this.indexOf(op.blockId, `${pointer}/blockId`);
    const owner = this.state.views?.find((view) => view.blockIds.includes(op.blockId));
    if (owner !== undefined && isRigidViewType(owner.type)) {
      throw new OpValidationError(
        `${pointer}/blockId`,
        `this is the block of a ${owner.type} view: remove the view instead`,
      );
    }
    if (owner !== undefined) owner.blockIds = owner.blockIds.filter((id) => id !== op.blockId);
    const [removed] = this.state.blocks.splice(index, 1);
    for (const bp of BREAKPOINTS) {
      this.state.layouts[bp] = this.state.layouts[bp].filter((item) => item.i !== op.blockId);
    }
    if (removed !== undefined) this.warnOrphanedVariables(removed);
  }

  /** Blocks still listening to a variable that only the removed block set. */
  private warnOrphanedVariables(removed: Block): void {
    const { blocks } = this.state;
    for (const variable of variablesSetBy(removed)) {
      if (blocks.some((block) => variablesSetBy(block).includes(variable))) continue;
      const listeners = blocks.filter((block) => block.listen?.includes(variable) === true);
      if (listeners.length === 0) continue;
      this.warnings.push(
        `${variable}: no block sets it any more; ${listeners.map((b) => b.id).join(', ')} still listen to it`,
      );
    }
  }

  /** Sets the positions given; blocks not mentioned keep theirs. */
  private arrange(op: OpOf<'arrange'>, pointer: string): void {
    const known = new Set(this.state.blocks.map((block) => block.id));
    for (const bp of BREAKPOINTS) {
      const given = op.layouts[bp];
      if (given === undefined) continue;
      const placed = new Set<string>();
      given.forEach((item, index) => {
        const itemPointer = `${pointer}/layouts/${bp}/${String(index)}/i`;
        if (!known.has(item.i)) throw new OpValidationError(itemPointer, 'no block with this id');
        if (placed.has(item.i)) {
          throw new OpValidationError(itemPointer, 'places the same block twice');
        }
        placed.add(item.i);
        const entry: LayoutItem = { i: item.i, ...position(item) };
        const items = this.state.layouts[bp];
        const existing = items.findIndex((current) => current.i === item.i);
        if (existing === -1) items.push(entry);
        else items[existing] = entry;
      });
    }
  }

  /**
   * Wires a cross-filter: the source (a chart's segment click, a filter) sets the variable; every
   * target listens to it and gets a rule binding it to the field, since listening alone filters
   * nothing. The field defaults to the one the source filters on.
   */
  private connectBlocks(op: OpOf<'connect_blocks'>, pointer: string): void {
    const fromIndex = this.indexOf(op.fromBlockId, `${pointer}/fromBlockId`);
    const source = this.blockAt(fromIndex);
    if (source.type !== 'chart' && source.type !== 'filter') {
      throw new OpValidationError(
        `${pointer}/fromBlockId`,
        'only a chart or a filter block sets a variable',
      );
    }
    const emitted = boundField(source);
    if (source.type === 'chart' && emitted === undefined) {
      throw new OpValidationError(
        `${pointer}/fromBlockId`,
        'a chart without a groupBy has no segments to click: it sets nothing',
      );
    }
    if (op.field !== undefined && emitted !== undefined && op.field !== emitted) {
      throw new OpValidationError(
        `${pointer}/field`,
        'must be the field the source filters on (a filter’s viz.field, a chart’s first groupBy)',
      );
    }
    const field = op.field ?? emitted;
    if (field === undefined) {
      throw new OpValidationError(
        `${pointer}/field`,
        'name the field the variable filters on: the source block names none',
      );
    }
    // A multi-select filter sets a list; so does a variable whose value is one.
    const name = op.variable.slice(VAR_REF_PREFIX.length);
    const list = source.viz['multi'] === true || Array.isArray(this.state.vars[name]);
    const seen = new Set<string>();
    op.toBlockIds.forEach((targetId, position) => {
      if (seen.has(targetId)) return;
      seen.add(targetId);
      const targetPointer = `${pointer}/toBlockIds/${String(position)}`;
      if (targetId === op.fromBlockId) {
        throw new OpValidationError(targetPointer, 'a block cannot listen to itself');
      }
      const targetIndex = this.indexOf(targetId, targetPointer);
      const target = this.blockAt(targetIndex);
      if (target.query === undefined) {
        throw new OpValidationError(targetPointer, 'this block has no query to filter');
      }
      const spec = lookupField(target.query.source, field);
      if (spec === null) {
        throw new OpValidationError(`${pointer}/field`, `not a field of ${target.query.source}`);
      }
      const operator = bindingOperator(spec, list);
      if (operator === null) {
        throw new OpValidationError(
          `${pointer}/field`,
          'this field takes one value (or one date range), but the source sets a list',
        );
      }
      const bound = bindRule(target.query.where, { field, operator, value: op.variable });
      const query: Query = { ...target.query, where: bound.where };
      // A variable whose binding was replaced no longer filters this block: stop listening to it.
      const read = variablesRead(query);
      const stale = new Set(bound.replaced.filter((variable) => !read.has(variable)));
      this.state.blocks[targetIndex] = {
        ...target,
        listen: unique([
          ...(target.listen ?? []).filter((variable) => !stale.has(variable)),
          op.variable,
        ]),
        query,
      };
    });
    this.state.blocks[fromIndex] =
      source.type === 'chart'
        ? { ...source, emits: { ...source.emits, onSegmentClick: op.variable } }
        : {
            ...source,
            sets: op.variable,
            // A filter offers the values of the field it filters on.
            viz: typeof source.viz['field'] === 'string' ? source.viz : { ...source.viz, field },
          };
  }

  /**
   * merge: the template's blocks join with fresh ids, below everything on each breakpoint; its
   * variables are added where the dashboard has none. replace: title, variables, blocks and layouts
   * become the template's. The scope never changes.
   */
  private applyTemplate(op: OpOf<'apply_template'>, pointer: string): void {
    const template = this.ctx.templates(op.templateKey);
    if (template === null) {
      throw new OpValidationError(`${pointer}/templateKey`, 'no template with this key');
    }
    const fresh = remapBlockIds(json(template), () => this.freshId());
    if (op.mode === 'replace') {
      // The Summary's blocks become the template's; the views and their blocks stay.
      const inViews = new Set((this.state.views ?? []).flatMap((view) => view.blockIds));
      this.state.title = fresh.title;
      this.state.vars = fresh.vars;
      this.state.blocks = [
        ...this.state.blocks.filter((block) => inViews.has(block.id)),
        ...fresh.blocks,
      ];
      for (const bp of BREAKPOINTS) {
        this.state.layouts[bp] = [
          ...this.state.layouts[bp].filter((item) => inViews.has(item.i)),
          ...fresh.layouts[bp],
        ];
      }
      return;
    }
    for (const bp of BREAKPOINTS) {
      const offset = bottom(this.gridItems(bp, null));
      this.state.layouts[bp].push(
        ...fresh.layouts[bp].map((item) => ({ ...item, y: item.y + offset })),
      );
    }
    this.state.blocks.push(...fresh.blocks);
    this.state.vars = { ...fresh.vars, ...this.state.vars };
  }

  private freshViewId(): string {
    const make = this.ctx.newViewId ?? newViewId;
    const taken = new Set((this.state.views ?? []).map((view) => view.id));
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = make();
      if (!taken.has(id)) return id;
    }
    throw new Error('newViewId keeps returning ids that are taken');
  }

  /**
   * A new view after the others. A rigid type gets one block with the type's catalog defaults
   * (and `config` on top); a dashboard view starts blank. A template brings its own blocks, with
   * fresh ids.
   */
  private addView(op: OpOf<'add_view'>, pointer: string): void {
    const views = this.state.views ?? [];
    if (views.length + 1 >= CAPS.maxViews) {
      throw new OpValidationError(
        pointer,
        `a page holds at most ${String(CAPS.maxViews)} views, the Summary included`,
      );
    }
    const id = this.freshViewId();
    if (op.templateKey !== undefined) {
      const template = this.ctx.viewTemplates?.(op.templateKey) ?? null;
      if (template === null) {
        throw new OpValidationError(`${pointer}/templateKey`, 'no view template with this key');
      }
      const fresh = remapBlockIds(
        { ...json(template), title: template.title, scope: this.state.scope, vars: {} },
        () => this.freshId(),
      );
      this.state.blocks.push(...fresh.blocks);
      for (const bp of BREAKPOINTS) this.state.layouts[bp].push(...fresh.layouts[bp]);
      this.state.vars = { ...template.vars, ...this.state.vars };
      this.ensureTopicVar();
      this.state.views = [
        ...views,
        {
          id,
          type: template.type,
          title: op.title ?? template.title,
          blockIds: fresh.blocks.map((block) => block.id),
          templateKey: template.key,
        },
      ];
      return;
    }
    const type = op.type;
    if (type === undefined) throw new OpValidationError(`${pointer}/type`, 'name a view type');
    const blockIds: string[] = [];
    if (isRigidViewType(type)) {
      const blockType = VIEW_BLOCK_TYPE[type];
      const entry = BLOCK_CATALOG[blockType];
      const config: ViewConfig = op.config ?? {};
      const { viz, ...fields } = config;
      const blockId = this.freshId();
      this.state.blocks.push({
        id: blockId,
        title: op.title ?? '',
        type: blockType,
        ...structuredClone(entry.defaults),
        ...fields,
        viz: { ...entry.defaults.viz, ...viz },
      });
      blockIds.push(blockId);
      if (config.query === undefined) this.scopeToTopic(blockId);
    } else if (op.config !== undefined) {
      throw new OpValidationError(
        `${pointer}/config`,
        'a dashboard view has no config: add blocks',
      );
    }
    this.state.views = [
      ...views,
      { id, type, title: op.title ?? defaultViewTitle(type), blockIds },
    ];
  }

  /** A topic page's `$page.topic` defaults to its topic, as its template's own blocks expect. */
  private ensureTopicVar(): void {
    const { topicId } = this.state.scope;
    if (topicId !== null && !Object.hasOwn(this.state.vars, 'topic')) {
      this.state.vars = { ...this.state.vars, topic: topicId };
    }
  }

  /** A new view of a topic page reads that topic's items: `topic = $page.topic`. */
  private scopeToTopic(blockId: string): void {
    if (this.state.scope.topicId === null) return;
    const index = this.indexOf(blockId, '');
    const block = this.blockAt(index);
    if (block.query?.source !== 'items') return;
    const { where } = bindRule(block.query.where, {
      field: 'topic',
      operator: '=',
      value: '$page.topic',
    });
    this.state.blocks[index] = {
      ...block,
      query: { ...block.query, where },
      listen: unique([...(block.listen ?? []), '$page.topic']),
    };
    this.ensureTopicVar();
  }

  private removeView(op: OpOf<'remove_view'>, pointer: string): void {
    const view = this.viewAt(op.viewId, `${pointer}/viewId`);
    const gone = new Set(view.blockIds);
    this.state.blocks = this.state.blocks.filter((block) => !gone.has(block.id));
    for (const bp of BREAKPOINTS) {
      this.state.layouts[bp] = this.state.layouts[bp].filter((item) => !gone.has(item.i));
    }
    this.state.views = (this.state.views ?? []).filter((entry) => entry.id !== op.viewId);
    if (this.state.views.length === 0) Reflect.deleteProperty(this.state, 'views');
  }

  private moveView(op: OpOf<'move_view'>, pointer: string): void {
    const view = this.viewAt(op.viewId, `${pointer}/viewId`);
    const rest = (this.state.views ?? []).filter((entry) => entry.id !== op.viewId);
    rest.splice(Math.min(op.index, rest.length), 0, view);
    this.state.views = rest;
  }

  private setView(op: OpOf<'set_view'>, pointer: string): void {
    const index = this.indexOf(op.blockId, `${pointer}/blockId`);
    const block = this.blockAt(index);
    if (block.type !== 'calendar') {
      throw new OpValidationError(`${pointer}/blockId`, 'set_view is for calendar blocks');
    }
    this.state.blocks[index] = { ...block, viz: { ...block.viz, view: op.view } };
  }
}

/** A blank view's title until the person names it (a literal; the client shows its own label). */
function defaultViewTitle(type: ViewType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** An op as received: no `$` keys, then the schema. */
function parseOp(raw: unknown, pointer: string): Op {
  try {
    assertSafeInput(raw, pointer);
  } catch (error) {
    if (error instanceof QueryValidationError) {
      throw new OpValidationError(error.pointer, error.reason);
    }
    throw error;
  }
  const parsed = OpSchema.safeParse(raw);
  if (!parsed.success) {
    const error = fromZodError(parsed.error);
    throw new OpValidationError(`${pointer}${error.pointer}`, error.reason);
  }
  return parsed.data;
}

/** Ops as received (a request body, an MCP call), parsed; OpValidationError at `/ops/<i>/…`. */
export function parseOps(raw: readonly unknown[]): Op[] {
  return raw.map((op, index) => parseOp(op, `/ops/${String(index)}`));
}

/**
 * Applies `ops` in order to a copy of `draft` and validates the result. Throws OpValidationError
 * (`/ops/<i>/…` for an op, `/blocks/<i>/…` and so on for the result) and leaves `draft` untouched.
 */
export function applyOps(
  draft: DashboardDraft,
  ops: readonly Op[],
  ctx: ApplyOpsContext,
): ApplyOpsResult {
  const before = json(draft);
  const editor = new Editor(json(draft), ctx);
  ops.forEach((raw, index) => {
    const pointer = `/ops/${String(index)}`;
    editor.apply(parseOp(raw, pointer), pointer);
  });
  const check = checkDraft(editor.state);
  const [first] = check.issues;
  if (check.draft === null || first !== undefined) {
    throw new OpValidationError(first?.pointer ?? '', first?.message ?? 'invalid dashboard');
  }
  const next = json(check.draft);
  return {
    next,
    patch: createPatch(before, next),
    inverse: createPatch(next, before),
    warnings: editor.warnings,
  };
}

function describeOp(op: Op): string {
  switch (op.op) {
    case 'add_block':
      return `add_block ${op.block.type}`;
    case 'update_block':
    case 'remove_block':
      return `${op.op} ${op.blockId}`;
    case 'connect_blocks':
      return `connect_blocks ${op.fromBlockId} ${op.variable}`;
    case 'apply_template':
      return `apply_template ${op.templateKey} ${op.mode}`;
    case 'set_view':
      return `set_view ${op.blockId} ${op.view}`;
    case 'add_view':
      return `add_view ${op.templateKey ?? op.type ?? ''}`.trim();
    case 'update_view':
    case 'remove_view':
    case 'move_view':
      return `${op.op} ${op.viewId}`;
    case 'arrange':
    case 'set_title':
    case 'set_vars':
    case 'set_importance':
      return op.op;
  }
}

/** A version's summary, e.g. "add_block deadlines": op names and ids only, never free text. */
export function summarizeOps(ops: readonly Op[]): string {
  const summary = ops.map(describeOp).join(', ');
  return summary.length <= MAX_SUMMARY ? summary : `${summary.slice(0, MAX_SUMMARY - 1)}…`;
}
