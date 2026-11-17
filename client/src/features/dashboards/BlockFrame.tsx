import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, LayoutGrid, RotateCw, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useBlockChrome } from './chrome';
import { rowsToPx } from './grid/constants';
import { ScrollArea } from '@/components/ui/scroll-area';

export type BlockStatus = 'loading' | 'error' | 'empty' | 'ready';

export interface BlockFrameProps {
  /** The block's title (data). */
  title: string;
  /** Default `ready`: the children show. */
  status?: BlockStatus;
  /** Controls at the end of the title row, such as a Week/Month toggle. */
  actions?: ReactNode;
  /**
   * The block's own menu (a trigger and its content), outside edit mode. In edit mode the grid's
   * menu (move, resize, edit, remove) takes this slot.
   */
  menu?: ReactNode;
  /** The empty state's message, computed by the block. Default: "Nothing to show yet". */
  emptyMessage?: string;
  /** The empty state's icon. Default: a grid. */
  emptyIcon?: ReactNode;
  /** Offers "Try again" in the error state. */
  onRetry?: () => void;
  /** Below the body, behind a hairline: "Show all", source links. */
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}

const HEADER_PX = 44;
const BODY_PADDING_PX = 16;
const SKELETON_ROW_PX = 28;
const MAX_SKELETON_ROWS = 14;
const SKELETON_WIDTHS = ['92%', '74%', '86%', '58%', '80%', '66%'];

/** As many skeleton rows as the block's body holds (three outside a grid). */
function skeletonRows(h: number | undefined): number {
  if (h === undefined) {
    return 3;
  }
  const body = rowsToPx(h) - HEADER_PX - BODY_PADDING_PX;
  return Math.min(MAX_SKELETON_ROWS, Math.max(1, Math.floor(body / SKELETON_ROW_PX)));
}

function BlockSkeleton({ title, h }: { title: string; h: number | undefined }) {
  const { t } = useTranslation();
  const rows = skeletonRows(h);
  return (
    <div role="status" className="flex flex-col gap-3.5 pt-1">
      <span className="sr-only">{t('blocks.loading', { title })}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton
          key={index}
          className="h-3.5 rounded-full"
          style={{ width: SKELETON_WIDTHS[index % SKELETON_WIDTHS.length] }}
        />
      ))}
    </div>
  );
}

/** Blocks this many rows tall or shorter show their states on one line. */
const COMPACT_ROWS = 3;

function BlockMessage({
  icon,
  message,
  action,
  tone = 'muted',
  compact,
}: {
  icon: ReactNode;
  message: string;
  action?: ReactNode;
  tone?: 'muted' | 'error';
  compact: boolean;
}) {
  if (compact) {
    return (
      <div className="flex h-full min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            'shrink-0 [&_svg]:size-4',
            tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {icon}
        </span>
        <p className="min-w-0 truncate text-[13px] text-muted-foreground">{message}</p>
        {action}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 py-2 text-center">
      <span
        aria-hidden="true"
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-full bg-sunken [&_svg]:size-[18px]',
          tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <p className="max-w-[32ch] text-[13px] leading-snug text-pretty text-muted-foreground">
        {message}
      </p>
      {action}
    </div>
  );
}

/**
 * Every block's frame (FRONTEND.md §5): an article named by its title, a title row with the
 * block's controls (and, in edit mode, the grid's handle and menu), and the body in one of four
 * states: loading (a skeleton the size of the block), empty, error (with "Try again") or ready.
 * Hairline and surface, no shadow (DESIGN.md).
 */
export function BlockFrame({
  title,
  status = 'ready',
  actions,
  menu,
  emptyMessage,
  emptyIcon,
  onRetry,
  footer,
  children,
  className,
}: BlockFrameProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const chrome = useBlockChrome();
  const menuSlot = chrome.editing ? chrome.menu : menu;
  const handle = chrome.editing ? chrome.handle : null;
  const compact = chrome.size !== undefined && chrome.size.h <= COMPACT_ROWS;
  const hasEndControls = actions !== undefined || (menuSlot !== undefined && menuSlot !== null);

  let body: ReactNode;
  switch (status) {
    case 'loading':
      body = <BlockSkeleton title={title} h={chrome.size?.h} />;
      break;
    case 'error':
      body = (
        <BlockMessage
          tone="error"
          compact={compact}
          icon={<CircleAlert />}
          message={t('blocks.error')}
          action={
            onRetry === undefined ? undefined : (
              <Button variant="outline" size={compact ? 'xs' : 'sm'} onClick={onRetry}>
                <RotateCw aria-hidden="true" />
                {t('blocks.retry')}
              </Button>
            )
          }
        />
      );
      break;
    case 'empty':
      body = (
        <BlockMessage
          compact={compact}
          icon={emptyIcon ?? <LayoutGrid />}
          message={emptyMessage ?? t('blocks.empty')}
        />
      );
      break;
    case 'ready':
      body = children;
      break;
  }

  return (
    <article
      aria-labelledby={titleId}
      aria-busy={status === 'loading' ? true : undefined}
      data-outlined={chrome.outlined ? '' : undefined}
      className={cn(
        'data-[outlined]:outline-foreground/70 flex h-full data-[outlined]:outline-2 data-[outlined]:outline-offset-2 min-h-0 flex-col overflow-hidden rounded-lg border bg-card text-card-foreground',
        className,
      )}
    >
      <header
        className={cn(
          'flex min-h-11 shrink-0 items-center gap-1.5',
          handle === null ? 'ps-4' : 'ps-1.5',
          hasEndControls ? 'pe-2' : 'pe-4',
        )}
      >
        {handle}
        <h2
          id={titleId}
          title={title}
          className="min-w-0 flex-1 truncate py-2.5 text-sm leading-5 font-semibold"
        >
          {title}
        </h2>
        {actions === undefined ? null : (
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        )}
        {menuSlot ?? null}
      </header>
      {chrome.source === null ? null : (
        <p
          role="status"
          {...(chrome.source === 'removed'
            ? { 'data-source-removed': '' }
            : { 'data-source-none': '' })}
          className="mx-4 mb-2 flex shrink-0 items-center gap-1.5 rounded-sm bg-sunken px-2 py-1 text-[13px] text-muted-foreground"
        >
          <Unplug aria-hidden="true" className="size-3.5 shrink-0" />
          {t(chrome.source === 'removed' ? 'blocks.sourceRemoved' : 'blocks.noSource')}
        </p>
      )}
      <ScrollArea
        focusable
        className={cn('relative min-h-0 flex-1', status === 'ready' ? '' : 'overflow-hidden')}
        viewportClassName="[&>div]:!h-full"
      >
        <div className={cn('h-full px-4', compact ? 'pb-3' : 'pb-4')}>{body}</div>
      </ScrollArea>
      {footer === undefined ? null : (
        <footer className="shrink-0 border-t px-4 py-2.5 text-[13px]">{footer}</footer>
      )}
    </article>
  );
}
