import { useTranslation } from 'react-i18next';
import { StickyNote } from 'lucide-react';
import { BlockFrame } from '../BlockFrame';
import { blockTitle } from '../chrome';
import type { BlockComponentProps } from '../registry/types';

/**
 * The user-authored text block. The text is rendered as a React text node with its line breaks
 * kept (`pre-wrap`), so there is no HTML or Markdown to inject. `dir="auto"` lets a Hebrew note
 * read right to left inside an English page and the other way round.
 */
export default function NoteBlock({ block }: BlockComponentProps) {
  const { t } = useTranslation();
  const note = block.note ?? '';
  const empty = note.trim() === '';
  return (
    <BlockFrame
      title={blockTitle(block, t)}
      status={empty ? 'empty' : 'ready'}
      emptyIcon={<StickyNote />}
      emptyMessage={t('blocks.note.empty')}
    >
      <p
        dir="auto"
        data-note-text=""
        className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
      >
        {note}
      </p>
    </BlockFrame>
  );
}
