import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Block, DocumentContent, Highlight, ReadingPosition, Sentence } from '@pagecast/core';

/**
 * The reading surface.
 *
 * Tokens are rendered once as spans carrying `data-b` / `data-t`, and the
 * karaoke hook mutates their classes directly each frame. Nothing here
 * re-renders during playback, which is what lets a 50-page document highlight
 * at 60fps.
 */

export interface ReaderCanvasProps {
  readonly content: DocumentContent;
  readonly highlights: readonly Highlight[];
  readonly onPlayFrom: (position: ReadingPosition) => void;
  readonly onHighlight: (blockIndex: number, startToken: number, endToken: number, note?: string) => void;
  /** A callback ref is fine here; the karaoke hook needs the element itself. */
  readonly containerRef: React.Ref<HTMLDivElement>;
}

interface SelectionTarget {
  blockIndex: number;
  startToken: number;
  endToken: number;
  x: number;
  y: number;
}

export function ReaderCanvas({ content, highlights, onPlayFrom, onHighlight, containerRef }: ReaderCanvasProps) {
  const [selection, setSelection] = useState<SelectionTarget | null>(null);

  // Sentence ranges per block, so each block renders its own sentence wrappers.
  const sentencesByBlock = useMemo(() => {
    const map = new Map<number, Sentence[]>();
    for (const sentence of content.sentences) {
      const list = map.get(sentence.blockIndex);
      if (list) list.push(sentence);
      else map.set(sentence.blockIndex, [sentence]);
    }
    return map;
  }, [content.sentences]);

  const highlightsByBlock = useMemo(() => {
    const map = new Map<number, Highlight[]>();
    for (const highlight of highlights) {
      const list = map.get(highlight.blockIndex);
      if (list) list.push(highlight);
      else map.set(highlight.blockIndex, [highlight]);
    }
    return map;
  }, [highlights]);

  /** Clicking a word starts playback from that word. */
  const onClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (window.getSelection()?.toString()) return; // a drag-select, not a click
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-t]');
      if (!target) return;
      const blockIndex = Number(target.dataset['b']);
      const tokenIndex = Number(target.dataset['t']);
      if (!Number.isFinite(blockIndex) || !Number.isFinite(tokenIndex)) return;
      onPlayFrom({ blockIndex, tokenIndex });
    },
    [onPlayFrom],
  );

  /** Turn a text selection into a token range so it can be highlighted. */
  const onMouseUp = useCallback(() => {
    const domSelection = window.getSelection();
    if (!domSelection || domSelection.isCollapsed || domSelection.rangeCount === 0) {
      setSelection(null);
      return;
    }

    const range = domSelection.getRangeAt(0);
    const startToken = tokenOf(range.startContainer);
    const endToken = tokenOf(range.endContainer);
    if (!startToken || !endToken || startToken.blockIndex !== endToken.blockIndex) {
      // Cross-paragraph selections are not annotatable in this pass.
      setSelection(null);
      return;
    }

    const box = range.getBoundingClientRect();
    setSelection({
      blockIndex: startToken.blockIndex,
      startToken: Math.min(startToken.tokenIndex, endToken.tokenIndex),
      endToken: Math.max(startToken.tokenIndex, endToken.tokenIndex) + 1,
      x: box.left + box.width / 2,
      y: box.top,
    });
  }, []);

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('.selection-menu')) setSelection(null);
    };
    window.document.addEventListener('mousedown', dismiss);
    return () => window.document.removeEventListener('mousedown', dismiss);
  }, []);

  return (
    <>
      <div
        className="canvas"
        ref={containerRef}
        onClick={onClick}
        onMouseUp={onMouseUp}
        role="article"
      >
        {content.blocks.map((block) => (
          <BlockView
            key={block.index}
            block={block}
            sentences={sentencesByBlock.get(block.index) ?? []}
            highlights={highlightsByBlock.get(block.index) ?? []}
          />
        ))}
      </div>

      {selection && (
        <SelectionMenu
          target={selection}
          onPlayFrom={() => {
            onPlayFrom({ blockIndex: selection.blockIndex, tokenIndex: selection.startToken });
            setSelection(null);
          }}
          onHighlight={(note) => {
            onHighlight(selection.blockIndex, selection.startToken, selection.endToken, note);
            window.getSelection()?.removeAllRanges();
            setSelection(null);
          }}
        />
      )}
    </>
  );
}

function tokenOf(node: Node): { blockIndex: number; tokenIndex: number } | null {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  const token = element?.closest<HTMLElement>('[data-t]');
  if (!token) return null;
  const blockIndex = Number(token.dataset['b']);
  const tokenIndex = Number(token.dataset['t']);
  return Number.isFinite(blockIndex) && Number.isFinite(tokenIndex) ? { blockIndex, tokenIndex } : null;
}

/**
 * One block. Memoised on identity: during playback nothing here changes, so
 * React never revisits the token tree.
 */
const BlockView = memo(function BlockView({
  block, sentences, highlights,
}: {
  block: Block;
  sentences: readonly Sentence[];
  highlights: readonly Highlight[];
}) {
  const Tag = tagFor(block);
  const highlighted = useMemo(() => {
    const set = new Set<number>();
    for (const h of highlights) {
      for (let t = h.startToken; t < h.endToken; t += 1) set.add(t);
    }
    return set;
  }, [highlights]);

  return (
    <Tag className={`block block--${block.type}`} data-block={block.index}>
      {sentences.map((sentence) => (
        <span className="block__sentence" data-sentence={sentence.index} key={sentence.index}>
          {block.tokens.slice(sentence.startToken, sentence.endToken).map((token) => {
            const next = block.tokens[token.i + 1];
            // Reproduce the original spacing and punctuation between tokens so
            // the rendered text reads exactly as the source did.
            const gap = block.text.slice(token.end, next ? next.start : block.text.length);
            return (
              <span key={token.i}>
                <span
                  className={highlighted.has(token.i) ? 'token token--noted' : 'token'}
                  data-b={block.index}
                  data-t={token.i}
                >
                  {token.text}
                </span>
                {gap}
              </span>
            );
          })}
        </span>
      ))}
    </Tag>
  );
});

function tagFor(block: Block): 'h1' | 'h2' | 'h3' | 'p' | 'li' | 'blockquote' | 'pre' {
  switch (block.type) {
    case 'heading1': return 'h1';
    case 'heading2': return 'h2';
    case 'heading3': return 'h3';
    case 'listItem': return 'li';
    case 'quote': return 'blockquote';
    case 'code': return 'pre';
    default: return 'p';
  }
}

/** The inline menu shown over a text selection. */
function SelectionMenu({
  target, onPlayFrom, onHighlight,
}: {
  target: SelectionTarget;
  onPlayFrom: () => void;
  onHighlight: (note?: string) => void;
}) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (noting) inputRef.current?.focus();
  }, [noting]);

  return (
    <div
      className="selection-menu"
      style={{ left: `${target.x}px`, top: `${target.y}px` }}
      role="dialog"
      aria-label="Selection actions"
    >
      {noting ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onHighlight(note.trim() || undefined);
          }}
        >
          <input
            ref={inputRef}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Add a note…"
            aria-label="Note"
          />
          <button type="submit" className="btn btn--primary">Save</button>
        </form>
      ) : (
        <>
          <button type="button" className="btn btn--ghost" onClick={() => onHighlight()}>Highlight</button>
          <button type="button" className="btn btn--ghost" onClick={() => setNoting(true)}>Add note</button>
          <button type="button" className="btn btn--ghost" onClick={onPlayFrom}>Play from here</button>
        </>
      )}
    </div>
  );
}
