/**
 * What a natural-key lookup needs to know of a dashboard (the demo data finding its pages, a
 * persona finding a topic's page), as an immutable value: which page it is and the shape of what
 * it holds, never its content. Dashboard.listOutlines answers these for every live dashboard of a
 * workspace, other members' private ones too, so none of them can be turned into a view from here.
 */
import { connectorsOf } from '../../builder/connectors.js';
import type { DashboardData, DashboardScope } from '../../models/definitions/Dashboard.js';
import { Layout } from './Layout.js';

export class DashboardOutline {
  readonly id: string;
  /** The draft's version. */
  readonly version: number;
  readonly templateKey: string | null;
  readonly scope: Readonly<DashboardScope>;
  /** How many blocks the draft holds. */
  readonly blockCount: number;
  /** Each block's connectors, in block order (`[]` for a block that names none). */
  readonly connectorSets: readonly (readonly string[])[];
  /** The view templates the draft's page views come from. */
  readonly viewTemplateKeys: readonly string[];
  /** The draft's grid. */
  readonly layout: Layout;

  private constructor(data: DashboardData) {
    this.id = data.id;
    this.version = data.version;
    this.templateKey = data.templateKey;
    this.scope = Object.freeze({ ...data.scope });
    this.blockCount = data.blocks.length;
    this.connectorSets = Object.freeze(
      data.blocks.map((block) => Object.freeze([...connectorsOf(block)])),
    );
    this.viewTemplateKeys = Object.freeze(
      data.views.flatMap((view) => {
        const key = (view as { templateKey?: unknown }).templateKey;
        return typeof key === 'string' ? [key] : [];
      }),
    );
    this.layout = Layout.of(data.layouts);
    Object.freeze(this);
  }

  /** The outline of a stored dashboard. */
  static of(data: DashboardData): DashboardOutline {
    return new DashboardOutline(data);
  }
}
