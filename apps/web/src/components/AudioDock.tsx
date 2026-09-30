import { useCallback, useEffect, useRef, useState } from 'react';
import type { Timeline, Voice } from '@pagecast/core';
import type { PlayerSnapshot } from '../player/audioEngine.js';

/**
 * The sticky playback dock.
 *
 * The scrubber is a native range input underneath a painted track: it keeps
 * keyboard and screen-reader support for free, which a div-and-pointer-events
 * implementation would have to rebuild badly.
 */

export interface AudioDockProps {
  readonly player: PlayerSnapshot;
  readonly timeline: Timeline | null;
  readonly voices: readonly Voice[];
  readonly voiceId: string;
  readonly synthesis: { done: number; total: number } | null;
  onToggle(): void;
  onSeek(ms: number): void;
  onSkip(seconds: number): void;
  onSpeed(speed: number): void;
  onVoice(voiceId: string): void;
}

const SPEED_PRESETS = [1, 1.5, 2, 2.5, 3];

export function AudioDock({
  player, timeline, voices, voiceId, synthesis, onToggle, onSeek, onSkip, onSpeed, onVoice,
}: AudioDockProps) {
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);

  const duration = player.durationMs;
  const displayMs = scrubbing ?? player.mediaMs;
  const percent = duration > 0 ? (displayMs / duration) * 100 : 0;
  const playing = player.status === 'playing';

  const commitScrub = useCallback(
    (value: number) => {
      onSeek(value);
      setScrubbing(null);
    },
    [onSeek],
  );

  return (
    <div className="dock" role="region" aria-label="Playback controls">
      <div className="dock__scrubber">
        <div className="dock__track">
          <div className="dock__buffered" style={{ width: `${bufferedPercent(timeline, duration)}%` }} />
          <div className="dock__played" style={{ width: `${percent}%` }} />
          <div className="dock__thumb" style={{ left: `${percent}%` }} />
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(1, duration)}
          step={100}
          value={displayMs}
          onChange={(event) => setScrubbing(Number(event.target.value))}
          onMouseUp={(event) => commitScrub(Number((event.target as HTMLInputElement).value))}
          onTouchEnd={(event) => commitScrub(Number((event.target as HTMLInputElement).value))}
          onKeyUp={(event) => {
            if (scrubbing !== null) commitScrub(Number((event.target as HTMLInputElement).value));
          }}
          aria-label="Seek"
          aria-valuetext={`${formatTime(displayMs)} of ${formatTime(duration)}`}
        />
      </div>

      <div className="dock__row">
        <div className="dock__time" aria-live="off">
          <span>{formatTime(displayMs)}</span>
          <span className="dock__time-sep">/</span>
          <span>{formatTime(duration)}</span>
        </div>

        <div className="dock__transport">
          <button type="button" className="btn btn--icon btn--ghost" onClick={() => onSkip(-15)} aria-label="Back 15 seconds" title="Back 15s (J)">
            <SkipIcon direction="back" />
          </button>

          <button
            type="button"
            className="dock__play"
            onClick={onToggle}
            aria-label={playing ? 'Pause' : 'Play'}
            title={playing ? 'Pause (Space)' : 'Play (Space)'}
            disabled={!timeline || timeline.chunks.length === 0}
          >
            {player.buffering && !playing ? <Spinner /> : playing ? <PauseIcon /> : <PlayIcon />}
          </button>

          <button type="button" className="btn btn--icon btn--ghost" onClick={() => onSkip(15)} aria-label="Forward 15 seconds" title="Forward 15s (L)">
            <SkipIcon direction="forward" />
          </button>
        </div>

        <div className="dock__settings">
          {synthesis && (
            <span className="dock__synthesis" role="status">
              Preparing audio {synthesis.done}/{synthesis.total}
            </span>
          )}

          <Popover
            open={speedOpen}
            onOpenChange={setSpeedOpen}
            label={`${player.speed.toFixed(1)}×`}
            title="Playback speed"
          >
            <div className="popover__title">Speed</div>
            <div className="speed__presets">
              {SPEED_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`chip${Math.abs(player.speed - preset) < 0.05 ? ' chip--on' : ''}`}
                  onClick={() => onSpeed(preset)}
                >
                  {preset}×
                </button>
              ))}
            </div>
            <input
              type="range"
              min={0.5}
              max={4.5}
              step={0.1}
              value={player.speed}
              onChange={(event) => onSpeed(Number(event.target.value))}
              aria-label="Playback speed"
            />
            <div className="speed__readout">{player.speed.toFixed(1)}× · 0.5 to 4.5</div>
          </Popover>

          <Popover
            open={voiceOpen}
            onOpenChange={setVoiceOpen}
            label={voices.find((v) => v.id === voiceId)?.label ?? 'Voice'}
            title="Voice"
            icon={<WaveformIcon />}
            collapsible
          >
            <div className="popover__title">Voice</div>
            <div className="voice__list">
              {voices.map((voice) => (
                <button
                  key={voice.id}
                  type="button"
                  className={`voice__item${voice.id === voiceId ? ' voice__item--on' : ''}`}
                  onClick={() => { onVoice(voice.id); setVoiceOpen(false); }}
                >
                  <span className="voice__name">{voice.label}</span>
                  <span className="voice__meta">{voice.accent} · {voice.baseWpm} wpm</span>
                </button>
              ))}
            </div>
          </Popover>
        </div>
      </div>

      {player.error && <div className="dock__error" role="alert">{player.error}</div>}
    </div>
  );
}

/** How much of the document has been synthesised, as a share of the timeline. */
function bufferedPercent(timeline: Timeline | null, durationMs: number): number {
  if (!timeline || durationMs <= 0) return 0;
  const last = timeline.chunks[timeline.chunks.length - 1];
  if (!last) return 0;
  return Math.min(100, ((last.startMs + last.durationMs) / durationMs) * 100);
}

function Popover({
  open, onOpenChange, label, title, icon, collapsible = false, children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  title: string;
  icon?: React.ReactNode;
  /** Narrow screens show the icon alone; the label would not fit. */
  collapsible?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      onOpenChange(false);
      // The reader listens on `window`, which fires after `document` in the
      // bubble phase, so stopping here means Escape closes this popover
      // without also leaving the document.
      event.stopPropagation();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div className="popover" ref={ref}>
      <button
        type="button"
        className="btn btn--ghost popover__trigger"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={title}
        aria-label={`${title}: ${label}`}
      >
        {icon}
        <span className={collapsible ? 'popover__label popover__label--collapsible' : 'popover__label'}>
          {label}
        </span>
      </button>
      {open && <div className="popover__panel" role="dialog" aria-label={title}>{children}</div>}
    </div>
  );
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/* --------------------------------------------------------------- icons */

function PlayIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.4-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14Z" /></svg>;
}
function PauseIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>;
}
function SkipIcon({ direction }: { direction: 'back' | 'forward' }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={direction === 'back' ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M12 4a8 8 0 1 1-8 8" />
      <path d="M12 8V1l5 3.5L12 8Z" fill="currentColor" stroke="none" />
      <text x="12" y="15.5" fontSize="7.5" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="600">15</text>
    </svg>
  );
}
function WaveformIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
    </svg>
  );
}

function Spinner() {
  return <svg className="spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity="0.25" /><path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round" /></svg>;
}
