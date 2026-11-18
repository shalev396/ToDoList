/**
 * An area (docs/superpowers/specs/2026-11-17-time-blocks-design.md, "Areas"): time painted for a
 * part of life ("Studying", "Work"), drawn behind everything else. The same record as a time block
 * with `props.layer: 'area'`, so it repeats, is edited and is deleted the same way. Not busy time:
 * blocks and items inside it are.
 */
import type { ItemData } from '../../models/definitions/Item.js';
import type { BlockLayer } from '../../types/scheduled.js';
import { Item } from './Item.js';
import { TimeBlock } from './TimeBlock.js';

export class TimeArea extends TimeBlock {
  static {
    Item.register('area', (data) => new TimeArea(data));
  }

  private constructor(data: ItemData) {
    super(data);
  }

  override readonly layer: BlockLayer = 'area';
}
