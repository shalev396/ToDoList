/**
 * What the page-variables panel lists (D4, H3): every `$page.*` variable of a page, with its
 * current value, where that value comes from, which blocks set it (a filter block, a chart click)
 * and which blocks and views listen to it. Computed over the whole page (the Summary and every
 * view), so a filter in one view that drives a block in another is visible. Pure; unit-tested.
 */
import type { Block, BlockType, VarValue } from '@api-types/builder.ts';
import type { DashboardView } from '@api-types/dashboards.ts';
import { viewOfBlock } from '../../views/viewModel.ts';
import { blockVarNames } from './blockVars.ts';
import { varNameOf } from './names.ts';
import { isDateRange, isUnsetValue, type PageVars } from './urlVars.ts';

/** Where a variable's current value comes from. */
export type VarOrigin = 'route' | 'url' | 'default' | 'unset';

/** How a block sets a variable. */
export type VarSetterKind = 'filter' | 'chartClick' | 'select';

export interface VarSetter {
  blockId: string;
  /** The block's title; '' when it has none (the panel names its type then). */
  title: string;
  type: BlockType;
  kind: VarSetterKind;
}

export interface VarListener {
  blockId: string;
  title: string;
  type: BlockType;
  /** The view it is in; null: the Summary. */
  viewId: string | null;
  viewTitle: string | null;
}

export interface PageVarEntry {
  /** The bare name: `topic` for `$page.topic`. */
  name: string;
  value: VarValue | undefined;
  origin: VarOrigin;
  /** Blocks that set it: a filter's `sets`, a chart's `emits`. */
  setters: VarSetter[];
  listeners: VarListener[];
  /** The route fixes it: it can't be cleared here. */
  bound: boolean;
  /** Something to clear: it has a value. */
  clearable: boolean;
}

export interface PageVarsInput {
  dashboard: Pick<DashboardView, 'vars' | 'blocks' | 'views'>;
  /** The merged values (defaults, then the URL, then the route). */
  vars: PageVars;
  /** What the URL itself sets (a variable reset to its default has no param). */
  urlVars: PageVars;
  bound: ReadonlySet<string>;
}

type Titled = Pick<Block, 'id' | 'title' | 'type'>;

function setterEntries(block: Block): { name: string; kind: VarSetterKind }[] {
  const out: { name: string; kind: VarSetterKind }[] = [];
  const push = (ref: string | undefined, kind: VarSetterKind): void => {
    const name = ref === undefined ? null : varNameOf(ref);
    if (name !== null) {
      out.push({ name, kind });
    }
  };
  push(block.sets, 'filter');
  push(block.emits?.onSegmentClick, 'chartClick');
  push(block.emits?.onSelect, 'select');
  return out;
}

/** A block's name for the panel: its title, or '' (the panel names the type then). */
export function panelTitle(block: Titled): string {
  return block.title.trim();
}

export function buildPageVarEntries(input: PageVarsInput): PageVarEntry[] {
  const { dashboard, vars, urlVars, bound } = input;
  const setters = new Map<string, VarSetter[]>();
  const listeners = new Map<string, VarListener[]>();
  const names = new Set<string>([
    ...Object.keys(dashboard.vars),
    ...Object.keys(urlVars),
    ...bound,
  ]);

  for (const block of dashboard.blocks) {
    for (const { name, kind } of setterEntries(block)) {
      names.add(name);
      setters.set(name, [
        ...(setters.get(name) ?? []),
        { blockId: block.id, title: panelTitle(block), type: block.type, kind },
      ]);
    }
    const view = viewOfBlock(dashboard, block.id);
    for (const name of blockVarNames(block)) {
      names.add(name);
      listeners.set(name, [
        ...(listeners.get(name) ?? []),
        {
          blockId: block.id,
          title: panelTitle(block),
          type: block.type,
          viewId: view?.id ?? null,
          viewTitle: view?.title ?? null,
        },
      ]);
    }
  }

  return [...names].sort().map((name): PageVarEntry => {
    const value = Object.hasOwn(vars, name) ? vars[name] : undefined;
    const isBound = bound.has(name);
    const origin: VarOrigin = isBound
      ? 'route'
      : Object.hasOwn(urlVars, name)
        ? 'url'
        : Object.hasOwn(dashboard.vars, name) && !isUnsetValue(dashboard.vars[name])
          ? 'default'
          : 'unset';
    return {
      name,
      value,
      origin,
      setters: setters.get(name) ?? [],
      listeners: listeners.get(name) ?? [],
      bound: isBound,
      clearable: !isBound && !isUnsetValue(value),
    };
  });
}

/** A value as the panel shows it: text, a list joined with commas, or `from → to`. */
export function varValueText(value: VarValue | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(String).join(', ');
  }
  if (isDateRange(value)) {
    return `${value.from} → ${value.to}`;
  }
  return String(value);
}
