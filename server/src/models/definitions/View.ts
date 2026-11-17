import type { Visibility } from '../../types/domain.js';

/** A saved query + visualization (DATA.md §3.13). */
export interface ViewData {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  title: string;
  /** FRONTEND.md §4 query JSON. */
  query: Record<string, unknown>;
  viz: Record<string, unknown>;
  visibility: Visibility;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateViewInput {
  ownerUserId: string;
  title: string;
  query: Record<string, unknown>;
  viz: Record<string, unknown>;
  visibility?: Visibility;
}

export interface ViewPatch {
  title?: string;
  query?: Record<string, unknown>;
  viz?: Record<string, unknown>;
  visibility?: Visibility;
}

export interface IViewRepository {
  create(workspaceId: string, input: CreateViewInput): Promise<ViewData>;
  findById(workspaceId: string, id: string): Promise<ViewData | null>;
  /** By title. */
  list(workspaceId: string): Promise<ViewData[]>;
  update(workspaceId: string, id: string, patch: ViewPatch): Promise<ViewData | null>;
  /** Hard delete. False when there was nothing to delete. */
  delete(workspaceId: string, id: string): Promise<boolean>;
  /** The workspace was deleted: removes every view of it. Returns how many. */
  deleteForWorkspace(workspaceId: string): Promise<number>;
  /** Every workspace id a view names: the purge's orphan sweep. Global. */
  listWorkspaceIds(): Promise<string[]>;
}

export const VIEW_TABLE_NAME = 'Views';
