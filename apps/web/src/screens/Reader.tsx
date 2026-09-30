import { useCallback, useEffect, useState } from 'react';
import { progressAt, type ReadingPosition } from '@pagecast/core';
import { api } from '../api/client.js';
import { AudioDock } from '../components/AudioDock.js';
import { ReaderCanvas } from '../components/ReaderCanvas.js';
import { useKaraoke } from '../player/useKaraoke.js';
import { useReader } from '../state/useReader.js';
import type { Settings } from '../state/settings.js';
import type { Highlight } from '@pagecast/core';

export interface ReaderProps {
  readonly documentId: string;
  readonly settings: Settings;
  onBack(): void;
  onUpdateSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
}

export function Reader({ documentId, settings, onBack, onUpdateSetting }: ReaderProps) {
  const reader = useReader(documentId);
  // Held as state, not a ref, so the karaoke hook re-runs when the canvas mounts.
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const [highlights, setHighlights] = useState<readonly Highlight[]>([]);
  const [showOutline, setShowOutline] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    setHighlights(reader.document?.highlights ?? []);
  }, [reader.document]);

  useKaraoke(canvasEl, reader.engine, reader.timeline, {
    autoScroll: settings.autoScroll,
    sentenceHighlight: settings.sentenceHighlight,
    onWordChange: reader.reportWord,
  });

  const { toggle, skip, skipSentence, setSpeed, player } = reader;

  /* Keyboard shortcuts, per the spec: space, J/L, arrows. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal keys from a field the reader is typing in.
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case ' ':
          event.preventDefault();
          toggle();
          break;
        case 'j': case 'J':
          event.preventDefault();
          skip(-15);
          break;
        case 'l': case 'L':
          event.preventDefault();
          skip(15);
          break;
        case 'ArrowUp':
          event.preventDefault();
          void setSpeed(Math.min(4.5, player.speed + 0.1));
          break;
        case 'ArrowDown':
          event.preventDefault();
          void setSpeed(Math.max(0.5, player.speed - 0.1));
          break;
        case 'ArrowLeft':
          event.preventDefault();
          skipSentence(-1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          skipSentence(1);
          break;
        case 'Escape':
          // Dismiss what is open before leaving the document, so Escape never
          // throws away someone's place to close a panel.
          if (showSettings) setShowSettings(false);
          else if (showOutline) setShowOutline(false);
          else onBack();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, skip, skipSentence, setSpeed, player.speed, onBack, showSettings, showOutline]);

  const addHighlight = useCallback(
    async (blockIndex: number, startToken: number, endToken: number, note?: string) => {
      try {
        const created = await api.addHighlight(documentId, { blockIndex, startToken, endToken, note });
        setHighlights((current) => [...current, created]);
      } catch {
        // Non-fatal: the reader keeps reading, the note is simply not saved.
      }
    },
    [documentId],
  );

  const playFrom = useCallback(
    (position: ReadingPosition) => {
      reader.seekToPosition(position);
      if (reader.player.status !== 'playing') reader.play();
    },
    [reader],
  );

  if (reader.loading) return <div className="reader reader--centered"><p className="empty">Opening…</p></div>;
  if (reader.error && !reader.document) {
    return (
      <div className="reader reader--centered">
        <p className="empty" role="alert">{reader.error}</p>
        <button type="button" className="btn" onClick={onBack}>Back to library</button>
      </div>
    );
  }
  if (!reader.document) return null;

  const { meta, content } = reader.document;
  const headings = content.blocks.filter((b) => b.type.startsWith('heading'));

  return (
    <div className="reader">
      <header className="reader__bar">
        <button type="button" className="btn btn--ghost" onClick={onBack}>← Library</button>
        <div className="reader__title">
          <h1>{meta.title}</h1>
          <p>
            {meta.author ? `${meta.author} · ` : ''}
            {meta.wordCount.toLocaleString()} words · {Math.round(reader.progress * 100)}% read
          </p>
        </div>
        <div className="reader__bar-actions">
          {headings.length > 1 && (
            <button type="button" className="btn btn--ghost" onClick={() => setShowOutline((v) => !v)} aria-pressed={showOutline}>
              Outline
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={() => setShowSettings((v) => !v)} aria-pressed={showSettings}>
            Aa
          </button>
        </div>
      </header>

      {reader.handoff && (
        <div className="handoff" role="status">
          <span>
            Another device is at {Math.round(progressAt(content, reader.handoff.position) * 100)}%.
          </span>
          <button type="button" className="btn btn--primary" onClick={reader.acceptHandoff}>Jump there</button>
          <button type="button" className="btn btn--ghost" onClick={reader.dismissHandoff}>Stay here</button>
        </div>
      )}

      {showSettings && (
        <div className="reader__panel" role="dialog" aria-label="Reading settings">
          <div className="field-row">
            <span>Typeface</span>
            <div className="segmented">
              {(['sans', 'serif', 'dyslexic'] as const).map((font) => (
                <button
                  key={font}
                  type="button"
                  className={settings.readingFont === font ? 'on' : ''}
                  onClick={() => onUpdateSetting('readingFont', font)}
                >
                  {font === 'sans' ? 'Sans' : font === 'serif' ? 'Serif' : 'Dyslexic'}
                </button>
              ))}
            </div>
          </div>
          <div className="field-row">
            <span>Theme</span>
            <div className="segmented">
              {(['light', 'sepia', 'dark'] as const).map((theme) => (
                <button
                  key={theme}
                  type="button"
                  className={settings.theme === theme ? 'on' : ''}
                  onClick={() => onUpdateSetting('theme', theme)}
                >
                  {theme[0]!.toUpperCase() + theme.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="field-row">
            <span>Text size</span>
            <input
              type="range" min={15} max={28} step={1}
              value={settings.fontSize}
              onChange={(e) => onUpdateSetting('fontSize', Number(e.target.value))}
              aria-label="Text size"
            />
          </div>
          <label className="field-row field-row--check">
            <input type="checkbox" checked={settings.autoScroll} onChange={(e) => onUpdateSetting('autoScroll', e.target.checked)} />
            <span>Follow along automatically</span>
          </label>
          <label className="field-row field-row--check">
            <input type="checkbox" checked={settings.sentenceHighlight} onChange={(e) => onUpdateSetting('sentenceHighlight', e.target.checked)} />
            <span>Tint the current sentence</span>
          </label>
        </div>
      )}

      <div className={`reader__body${showOutline ? ' reader__body--with-outline' : ''}`}>
        {showOutline && (
          <nav className="outline" aria-label="Document outline">
            {headings.map((heading) => (
              <button
                key={heading.index}
                type="button"
                className={`outline__item outline__item--${heading.type}`}
                onClick={() => playFrom({ blockIndex: heading.index, tokenIndex: 0 })}
              >
                {heading.text}
              </button>
            ))}
          </nav>
        )}

        <main className="reader__scroll">
          <ReaderCanvas
            content={content}
            highlights={highlights}
            containerRef={setCanvasEl}
            onPlayFrom={playFrom}
            onHighlight={(b, s, e, note) => void addHighlight(b, s, e, note)}
          />
          <div className="reader__end">End of document</div>
        </main>
      </div>

      <AudioDock
        player={reader.player}
        timeline={reader.timeline}
        voices={reader.voices}
        voiceId={reader.voiceId}
        synthesis={reader.synthesis}
        onToggle={reader.toggle}
        onSeek={reader.seekToMs}
        onSkip={reader.skip}
        onSpeed={reader.setSpeed}
        onVoice={reader.setVoice}
      />
    </div>
  );
}
