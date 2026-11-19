/**
 * A member's place for travel (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Concepts"):
 * a name, aliases, and an address if he typed one (free text, only for opening a map app: nothing
 * is looked up, and no coordinate is kept). Private to its member: every read and write names the
 * owner as well as the workspace. At most one place per member is Home (a unique partial index
 * holds it).
 */
export interface PlaceData {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  aliases: string[];
  /** As typed; null when he gave none. */
  address: string | null;
  home: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewPlaceRecord {
  ownerUserId: string;
  name: string;
  aliases: string[];
  address: string | null;
  home: boolean;
}

export interface PlacePatch {
  name?: string;
  aliases?: string[];
  address?: string | null;
  home?: boolean;
}

export interface IPlaceRepository {
  create(workspaceId: string, input: NewPlaceRecord): Promise<PlaceData>;
  /** The owner's place with this id; null for anyone else's, or none. */
  findOwn(workspaceId: string, ownerUserId: string, id: string): Promise<PlaceData | null>;
  /** The owner's places, oldest first. */
  listOwn(workspaceId: string, ownerUserId: string): Promise<PlaceData[]>;
  countOwn(workspaceId: string, ownerUserId: string): Promise<number>;
  /** Null when the owner has no such place. */
  update(
    workspaceId: string,
    ownerUserId: string,
    id: string,
    patch: PlacePatch,
  ): Promise<PlaceData | null>;
  /** The owner's Home is Home no more (but `exceptId`'s). Returns how many changed. */
  clearHome(workspaceId: string, ownerUserId: string, exceptId?: string): Promise<number>;
  /** Hard delete. False when there was nothing to delete. */
  delete(workspaceId: string, ownerUserId: string, id: string): Promise<boolean>;
  /** A membership ended: every place of the member, hard-deleted. Returns how many. */
  deleteForMember(workspaceId: string, ownerUserId: string): Promise<number>;
  /** The workspace was deleted: every place in it. Returns how many. */
  deleteForWorkspace(workspaceId: string): Promise<number>;
}

export const PLACE_TABLE_NAME = 'Places';
