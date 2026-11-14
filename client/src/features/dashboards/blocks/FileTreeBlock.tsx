import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Eye, FileText, Folder, FolderOpen, FolderTree, Image } from 'lucide-react';
import { SourceDot } from '@/components/items/SourceDot';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { displayProvider } from './data/rows';
import { useItemParam } from '@/features/items/useItemParam';
import { SourceLink } from '@/features/items/SourceLink';
import { cn } from '@/lib/utils';
import type { ItemQueryRow } from '@api-types/builder';
import { BlockFrame } from '../BlockFrame';
import { blockTitle } from '../chrome';
import type { BlockComponentProps } from '../registry/types';
import type { DisplayedRow } from '../rules/applyDisplayRules';
import { buildFileTree, previewUrlOf, type FileTreeNode } from './data/fileTree';
import { ToneRow } from './data/RowParts';
import { truncateText } from './data/truncate';
import { useDataBlock } from './data/useDataBlock';

type Entry = DisplayedRow<ItemQueryRow>;

interface Flat {
  id: string;
  parent: string | null;
  node: FileTreeNode<Entry>;
  level: number;
  posInSet: number;
  setSize: number;
}

const fileId = (entry: Entry) => `file:${entry.row.id}`;

/** The visible rows in order: a folder's children only while it is expanded. */
function flatten(
  nodes: readonly FileTreeNode<Entry>[],
  expanded: ReadonlySet<string>,
  level = 1,
  parent: string | null = null,
): Flat[] {
  return nodes.flatMap((node, index) => {
    const id = node.kind === 'folder' ? node.id : fileId(node.row);
    const self: Flat = { id, parent, node, level, posInSet: index + 1, setSize: nodes.length };
    return node.kind === 'folder' && expanded.has(node.id)
      ? [self, ...flatten(node.children, expanded, level + 1, id)]
      : [self];
  });
}

function Preview({ entry, onClose }: { entry: Entry | null; onClose: () => void }) {
  const { t } = useTranslation();
  const url = entry === null ? null : previewUrlOf(entry.row.props);
  const name = entry === null ? '' : truncateText(entry.row.title, 120);
  return (
    <Sheet
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent
        aria-describedby={undefined}
        closeLabel={t('dataBlocks.close')}
        className="w-[min(40rem,100vw)] sm:max-w-2xl"
      >
        <SheetHeader>
          <SheetTitle className="truncate pe-10" title={entry?.row.title}>
            {t('dataBlocks.files.previewTitle', { name })}
          </SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 px-4 pb-4">
          {url === null ? (
            <p className="text-[13px] text-muted-foreground">{t('dataBlocks.files.noPreview')}</p>
          ) : (
            <iframe
              src={url}
              title={t('dataBlocks.files.previewOf', { name })}
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="no-referrer"
              className="size-full min-h-96 rounded-md border bg-sunken"
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * File tree (FRONTEND.md §5, ruling T2.3): the folders of a Drive or Notability backup, built from
 * file ITEMS only, each file's `props.path` giving its folders. A WAI-ARIA tree: arrows move,
 * Right and Left open and close or step to the parent, Home and End jump. Each file has "Open in
 * <provider>", and a preview for a PDF or an image.
 */
export default function FileTreeBlock({ dashboard, block }: BlockComponentProps) {
  const { t, i18n } = useTranslation();
  const { query, rows, loadState } = useDataBlock(dashboard, block);
  const title = blockTitle(block, t);
  const collator = useMemo(
    () => new Intl.Collator(i18n.language, { numeric: true }),
    [i18n.language],
  );
  const files = useMemo(() => rows.filter((entry) => entry.row.kind === 'file'), [rows]);
  const tree = useMemo(
    () =>
      buildFileTree(
        files,
        (entry) => truncateText(entry.row.title, 160) || t('dataBlocks.noTitle'),
        (entry) => entry.row.props,
        collator,
      ),
    [files, collator, t],
  );

  // Folders the user toggled by hand; first-level folders start open.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const expanded = useMemo(() => {
    const set = new Set<string>();
    const visit = (nodes: readonly FileTreeNode<Entry>[], level: number) => {
      for (const node of nodes) {
        if (node.kind === 'folder') {
          if (toggled.get(node.id) ?? level === 1) {
            set.add(node.id);
          }
          visit(node.children, level + 1);
        }
      }
    };
    visit(tree, 1);
    return set;
  }, [tree, toggled]);
  const flat = useMemo(() => flatten(tree, expanded), [tree, expanded]);

  const [focusId, setFocusId] = useState<string | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const [preview, setPreview] = useState<Entry | null>(null);
  const { openItem } = useItemParam();
  const current = flat.some((item) => item.id === focusId) ? focusId : (flat[0]?.id ?? null);

  const toggle = (id: string, open: boolean) => {
    setToggled((map) => new Map(map).set(id, open));
  };
  const focus = (id: string | undefined) => {
    if (id !== undefined) {
      setFocusId(id);
      nodes.current.get(id)?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, item: Flat, index: number) => {
    // Keys pressed on a file's own buttons and links belong to them.
    if (event.target !== event.currentTarget) {
      return;
    }
    const isFolder = item.node.kind === 'folder';
    const open = isFolder && expanded.has(item.id);
    // Arrow keys follow the document direction: "forward" opens, "back" closes.
    const rtl = document.documentElement.dir === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    switch (event.key) {
      case 'ArrowDown':
        focus(flat[index + 1]?.id);
        break;
      case 'ArrowUp':
        focus(flat[index - 1]?.id);
        break;
      case 'Home':
        focus(flat[0]?.id);
        break;
      case 'End':
        focus(flat[flat.length - 1]?.id);
        break;
      case forward:
        if (isFolder) {
          if (open) {
            focus(flat[index + 1]?.id);
          } else {
            toggle(item.id, true);
          }
        }
        break;
      case back:
        if (open) {
          toggle(item.id, false);
        } else if (item.parent !== null) {
          focus(item.parent);
        }
        break;
      case 'Enter':
      case ' ':
        if (item.node.kind === 'folder') {
          toggle(item.id, !open);
        } else {
          openItem(item.node.row.row.id);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const status = loadState !== 'ready' ? loadState : files.length === 0 ? 'empty' : 'ready';

  const renderNodes = (list: readonly FileTreeNode<Entry>[]): ReactNode =>
    list.map((node) => {
      const id = node.kind === 'folder' ? node.id : fileId(node.row);
      const index = flat.findIndex((item) => item.id === id);
      const item = flat[index];
      if (item === undefined) {
        return null;
      }
      const indent = { paddingInlineStart: `${String((item.level - 1) * 16 + 4)}px` };
      const common = {
        ref: (element: HTMLElement | null) => {
          if (element === null) {
            nodes.current.delete(id);
          } else {
            nodes.current.set(id, element);
          }
        },
        tabIndex: current === id ? 0 : -1,
        'aria-level': item.level,
        'aria-setsize': item.setSize,
        'aria-posinset': item.posInSet,
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
          onKeyDown(event, item, index);
        },
        onFocus: () => {
          setFocusId(id);
        },
        style: indent,
      };
      if (node.kind === 'folder') {
        const open = expanded.has(node.id);
        return (
          <li key={id} role="none">
            <div
              role="treeitem"
              aria-expanded={open}
              {...common}
              onClick={() => {
                toggle(node.id, !open);
              }}
              className="flex min-h-9 cursor-pointer items-center gap-1.5 rounded-sm pe-2 text-sm hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:min-h-11"
            >
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  'size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                  open ? 'rotate-90' : 'rtl:-scale-x-100',
                )}
              />
              {open ? (
                <FolderOpen aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span title={node.name} className="min-w-0 flex-1 truncate">
                {node.name}
              </span>
              <span className="sr-only">
                {t(open ? 'dataBlocks.files.collapse' : 'dataBlocks.files.expand', {
                  name: node.name,
                })}
              </span>
            </div>
            {open ? (
              <ul role="group" className="m-0 list-none p-0">
                {renderNodes(node.children)}
              </ul>
            ) : null}
          </li>
        );
      }
      const entry = node.row;
      const previewable = previewUrlOf(entry.row.props) !== null;
      const Icon =
        typeof entry.row.props['mimeType'] === 'string' &&
        entry.row.props['mimeType'].startsWith('image/')
          ? Image
          : FileText;
      return (
        <li key={id} role="none">
          <ToneRow tone={entry.tone}>
            <div
              role="treeitem"
              aria-selected={false}
              {...common}
              onClick={() => {
                openItem(entry.row.id);
              }}
              className="flex min-h-9 items-center gap-1.5 rounded-sm text-sm hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:min-h-11"
            >
              <span aria-hidden="true" className="size-4 shrink-0" />
              <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span title={entry.row.title} className="min-w-0 flex-1 truncate">
                {node.name}
              </span>
              <SourceDot
                source={displayProvider(entry.row.source.provider)}
                className="shrink-0 px-1"
              />
              {/* The file's actions live in its row, so the tree holds only tree items. */}
              <span
                className="flex shrink-0 items-center"
                onClick={(event) => {
                  event.stopPropagation();
                }}
              >
                {previewable ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('dataBlocks.files.previewOf', { name: node.name })}
                    onClick={() => {
                      setPreview(entry);
                    }}
                  >
                    <Eye aria-hidden="true" />
                  </Button>
                ) : null}
                <SourceLink source={entry.row.source} title={node.name} />
              </span>
            </div>
          </ToneRow>
        </li>
      );
    });

  return (
    <BlockFrame
      title={title}
      status={status}
      onRetry={() => {
        void query.refetch();
      }}
      emptyIcon={<FolderTree />}
      emptyMessage={t('dataBlocks.files.empty')}
      footer={
        <span className="text-muted-foreground">
          {t('dataBlocks.files.filesCount', { count: files.length })}
        </span>
      }
    >
      <ul role="tree" aria-label={title} className="m-0 list-none p-0">
        {renderNodes(tree)}
      </ul>
      <Preview
        entry={preview}
        onClose={() => {
          setPreview(null);
        }}
      />
    </BlockFrame>
  );
}
