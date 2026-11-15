/**
 * Tests only: the item reads and writes in the call shapes the suites used before the item classes
 * (a workspace context and a user id), each one line over the classes (classes/item/), so the
 * safety net keeps its assertions while the code moved underneath it.
 */
import { Actor } from '../classes/base/Actor.js';
import { Caller, type WorkspaceContext } from '../classes/base/Caller.js';
import {
  Item,
  ItemEdit,
  ItemQuery,
  Todo,
  type ItemListQuery,
  type LooseItemEditInput,
  type NewTodo,
  type OverlayEdit,
} from '../classes/item/index.js';
import { MirroredItemError } from '../errors/MirroredItemError.js';
import type {
  FacetsResponseData,
  ItemDetail,
  ListItemsResponseData,
} from '../routes/private/items.js';

/** The 409 a mirrored item answers, under the name the suites know. */
export { MirroredItemError as ItemMirroredResponse };
export type { ItemListQuery };

function callerOf(ws: WorkspaceContext, userId: string): Caller {
  return Caller.fromContext(ws, Actor.user(userId));
}

export async function listItems(
  ws: WorkspaceContext,
  userId: string,
  query: ItemListQuery,
): Promise<ListItemsResponseData> {
  return (await ItemQuery.for(callerOf(ws, userId))).list(query);
}

export async function getItem(
  ws: WorkspaceContext,
  userId: string,
  id: string,
): Promise<ItemDetail> {
  return (await ItemQuery.for(callerOf(ws, userId))).get(id);
}

export async function getFacets(
  ws: WorkspaceContext,
  userId: string,
  connectors?: readonly string[],
): Promise<FacetsResponseData> {
  return (await ItemQuery.for(callerOf(ws, userId))).facets(connectors);
}

export async function createItem(
  ws: WorkspaceContext,
  userId: string,
  input: NewTodo,
): Promise<{ item: ItemDetail; created: boolean }> {
  const caller = callerOf(ws, userId);
  const { todo, created } = await Todo.create(caller, input);
  return { item: await (await ItemQuery.for(caller)).detail(todo), created };
}

export async function updateItem(
  ws: WorkspaceContext,
  userId: string,
  id: string,
  input: LooseItemEditInput,
): Promise<ItemDetail> {
  const caller = callerOf(ws, userId);
  const edited = await (await Item.find(caller, id)).edit(caller, ItemEdit.of(input));
  return (await ItemQuery.for(caller)).detail(edited);
}

export async function updateOverlay(
  ws: WorkspaceContext,
  userId: string,
  id: string,
  overlay: OverlayEdit,
): Promise<ItemDetail> {
  const caller = callerOf(ws, userId);
  const updated = await (await Item.find(caller, id)).setOverlay(caller, overlay);
  return (await ItemQuery.for(caller)).detail(updated);
}

export async function deleteItem(ws: WorkspaceContext, userId: string, id: string): Promise<void> {
  const caller = callerOf(ws, userId);
  const item = await Item.find(caller, id);
  if (!(item instanceof Todo)) throw new MirroredItemError(item.provider, item.sourceUrl);
  await item.delete(caller);
}
