export interface FileTreeFile<R> {
  kind: 'file';
  name: string;
  row: R;
}
export interface FileTreeFolder<R> {
  kind: 'folder';
  /** The folder's path from the root, joined: its stable id. */
  id: string;
  name: string;
  children: FileTreeNode<R>[];
}
export type FileTreeNode<R> = FileTreeFile<R> | FileTreeFolder<R>;

/** A file's folders from its `props.path` (an array of names from the root); bad values = root. */
export function pathOf(props: Record<string, unknown>): string[] {
  const path = props['path'];
  return Array.isArray(path)
    ? path.filter((part): part is string => typeof part === 'string' && part !== '')
    : [];
}

/**
 * The folder tree of a set of file rows (the query returns files only; folders come from each
 * file's path). Folders first, then files, each by name.
 */
export function buildFileTree<R>(
  rows: readonly R[],
  nameOf: (row: R) => string,
  propsOf: (row: R) => Record<string, unknown>,
  collator: Intl.Collator = new Intl.Collator(),
): FileTreeNode<R>[] {
  const root: FileTreeFolder<R> = { kind: 'folder', id: '', name: '', children: [] };
  for (const row of rows) {
    let folder = root;
    for (const part of pathOf(propsOf(row))) {
      const id = `${folder.id}/${part}`;
      let next = folder.children.find(
        (child): child is FileTreeFolder<R> => child.kind === 'folder' && child.id === id,
      );
      if (next === undefined) {
        next = { kind: 'folder', id, name: part, children: [] };
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push({ kind: 'file', name: nameOf(row), row });
  }
  const sort = (nodes: FileTreeNode<R>[]) => {
    nodes.sort((a, b) =>
      a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'folder' ? -1 : 1,
    );
    for (const node of nodes) {
      if (node.kind === 'folder') {
        sort(node.children);
      }
    }
  };
  sort(root.children);
  return root.children;
}

/** Every folder id, in tree order. */
export function folderIds<R>(nodes: readonly FileTreeNode<R>[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === 'folder' ? [node.id, ...folderIds(node.children)] : [],
  );
}

/** A PDF or an image can be previewed; anything else only opens in its source. */
export function isPreviewable(props: Record<string, unknown>): boolean {
  const mime = props['mimeType'];
  return typeof mime === 'string' && (mime === 'application/pdf' || mime.startsWith('image/'));
}

const DRIVE_FILE_ID = /^[\w-]{8,100}$/;

/**
 * The embeddable preview of a file, from its data: an explicit `props.previewUrl`, else Drive's
 * `/preview` page for `props.driveFileId`. Only https URLs are ever framed.
 */
export function previewUrlOf(props: Record<string, unknown>): string | null {
  if (!isPreviewable(props)) {
    return null;
  }
  const explicit = props['previewUrl'];
  if (typeof explicit === 'string' && explicit.startsWith('https://')) {
    return explicit;
  }
  const id = props['driveFileId'];
  return typeof id === 'string' && DRIVE_FILE_ID.test(id)
    ? `https://drive.google.com/file/d/${id}/preview`
    : null;
}
