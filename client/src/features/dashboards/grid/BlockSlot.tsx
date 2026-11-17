import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutGrid } from 'lucide-react';
import { BlockFrame } from '../BlockFrame';
import { blockTitle } from '../chrome';
import { blockEntry } from '../registry';
import { BlockEntryContext } from '../registry/blockEntryContext';
import type { BlockComponentProps } from '../registry/types';

interface BoundaryProps {
  fallback: (retry: () => void) => ReactNode;
  children: ReactNode;
}

/** One block that throws shows its frame's error state; the rest of the page stays. */
class BlockErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[dashboard] a block failed to render', error, info.componentStack);
  }

  retry = (): void => {
    this.setState({ failed: false });
  };

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}

/**
 * A block in the grid: its registry component (loaded on first use), with the frame's loading
 * state while the component's code loads and its error state if it throws. The page never
 * switches on the block type; a type this client does not know yet shows a placeholder.
 */
export function BlockSlot(props: BlockComponentProps) {
  const { t } = useTranslation();
  const { block } = props;
  const title = blockTitle(block, t);
  const entry = blockEntry(block.type);
  if (entry === undefined) {
    return (
      <BlockFrame
        title={title}
        status="empty"
        emptyIcon={<LayoutGrid />}
        emptyMessage={t('blocks.comingSoon')}
      />
    );
  }
  const BlockComponent = entry.component;
  // The entry goes down by context: the block and useBlockData never import the registry.
  return (
    <BlockEntryContext value={entry}>
      <BlockErrorBoundary
        fallback={(retry) => <BlockFrame title={title} status="error" onRetry={retry} />}
      >
        <Suspense fallback={<BlockFrame title={title} status="loading" />}>
          <BlockComponent {...props} />
        </Suspense>
      </BlockErrorBoundary>
    </BlockEntryContext>
  );
}
