import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fromGlobalWordIndex, positionAtTime, progressAt, resumeTarget, seekBySentence,
  shouldPushPosition, timeAtPosition, toGlobalWordIndex,
  type ActiveSpan, type ReadingPosition, type ReadingState, type Timeline, type Voice,
} from '@pagecast/core';
import { api, deviceId, type FullDocument } from '../api/client.js';
import { syncChannel } from '../api/sync.js';
import { AudioEngine, type PlayerSnapshot } from '../player/audioEngine.js';
import { usePlayerClock } from '../player/usePlayerClock.js';

/**
 * Everything the reader screen needs, in one place: the document, the audio
 * timeline as it grows, the playback engine, and the two-way position sync.
 */

export interface ReaderApi {
  readonly document: FullDocument | null;
  readonly timeline: Timeline | null;
  readonly engine: AudioEngine;
  readonly player: PlayerSnapshot;
  readonly voices: readonly Voice[];
  readonly voiceId: string;
  readonly synthesis: { done: number; total: number } | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly progress: number;
  /** Set when another device moved the reader while this one was open. */
  readonly handoff: ReadingState | null;

  play(): void;
  pause(): void;
  toggle(): void;
  seekToMs(ms: number): void;
  seekToPosition(position: ReadingPosition): void;
  skip(seconds: number): void;
  skipSentence(delta: number): void;
  setSpeed(speed: number): void;
  setVoice(voiceId: string): void;
  acceptHandoff(): void;
  dismissHandoff(): void;
  reportWord(span: ActiveSpan): void;
}

const VOICE_KEY = 'pagecast.voiceId';

export function useReader(documentId: string | null): ReaderApi {
  const engine = useMemo(() => new AudioEngine(), []);
  const [document, setDocument] = useState<FullDocument | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [voices, setVoices] = useState<readonly Voice[]>([]);
  const [voiceId, setVoiceId] = useState<string>(() => {
    try { return localStorage.getItem(VOICE_KEY) ?? ''; } catch { return ''; }
  });
  // `rawPlayer` changes only on real state transitions; the playhead ticks
  // separately so the dock can animate without re-rendering on every frame.
  const [rawPlayer, setRawPlayer] = useState<PlayerSnapshot>(() => engine.snapshot());
  const [synthesis, setSynthesis] = useState<{ done: number; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [handoff, setHandoff] = useState<ReadingState | null>(null);

  /** The server revision this client believes it is building on. */
  const revRef = useRef(0);
  const positionRef = useRef<ReadingPosition>({ blockIndex: 0, tokenIndex: 0 });
  const lastPushRef = useRef<{ wordIndex: number; atMs: number } | null>(null);
  const documentRef = useRef<FullDocument | null>(null);
  documentRef.current = document;

  useEffect(() => engine.subscribe(setRawPlayer), [engine]);
  useEffect(() => () => engine.destroy(), [engine]);

  const clockMs = usePlayerClock(engine, rawPlayer.status === 'playing');
  const player = useMemo<PlayerSnapshot>(
    () => ({ ...rawPlayer, mediaMs: clockMs }),
    [rawPlayer, clockMs],
  );

  /* ------------------------------------------------------------- voices */

  useEffect(() => {
    let cancelled = false;
    api.listVoices()
      .then((list) => {
        if (cancelled) return;
        setVoices(list);
        setVoiceId((current) => (current && list.some((v) => v.id === current) ? current : list[0]?.id ?? ''));
      })
      .catch((err: unknown) => setError(messageOf(err)));
    return () => { cancelled = true; };
  }, []);

  /* ----------------------------------------------------------- document */

  useEffect(() => {
    if (!documentId) {
      setDocument(null);
      setTimeline(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setHandoff(null);

    api.getDocument(documentId)
      .then((doc) => {
        if (cancelled) return;
        setDocument(doc);
        revRef.current = doc.state.rev;
        positionRef.current = doc.state.position;
        setProgress(doc.state.progress);
        // Resuming at the start of the sentence restores the context a
        // listener lost when they stopped.
        positionRef.current = resumeTarget(doc.content, doc.state.position);
        if (doc.state.voiceId) setVoiceId(doc.state.voiceId);
      })
      .catch((err: unknown) => { if (!cancelled) setError(messageOf(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    syncChannel.connect();
    syncChannel.subscribe(documentId);
    return () => {
      cancelled = true;
      syncChannel.unsubscribe(documentId);
    };
  }, [documentId]);

  /* ----------------------------------------------------------- timeline */

  useEffect(() => {
    if (!documentId || !voiceId || !document) return;

    let cancelled = false;
    let poll: number | null = null;

    const apply = (next: Timeline | null, done: number, total: number) => {
      if (cancelled || !next) return;
      setTimeline((current) => {
        // Only re-seat the engine when the timeline actually grew.
        if (current && current.chunks.length === next.chunks.length && current.voiceId === next.voiceId) {
          return current;
        }
        if (current && current.voiceId === next.voiceId) engine.updateTimeline(next);
        else void engine.load(next, timeAtPosition(next, positionRef.current), engine.getSpeed());
        return next;
      });
      setSynthesis(total > 0 && done < total ? { done, total } : null);
    };

    const pump = async () => {
      try {
        const started = await api.startSynthesis(documentId, voiceId);
        if (cancelled) return;
        if (started.timeline) apply(started.timeline, started.timeline.chunks.length, 0);

        // Keep pulling until every chunk has landed.
        const poll_ = async () => {
          if (cancelled) return;
          const { timeline: next, done, total, error: failure } = await api.getTimeline(documentId, voiceId);
          if (cancelled) return;
          if (failure) { setError(failure); return; }
          apply(next, done, total);
          if (total === 0 || done < total) poll = window.setTimeout(() => void poll_(), 1_200);
        };
        await poll_();
      } catch (err) {
        if (!cancelled) setError(messageOf(err));
      }
    };

    void pump();
    return () => {
      cancelled = true;
      if (poll !== null) clearTimeout(poll);
    };
  }, [documentId, voiceId, document, engine]);

  /* --------------------------------------------------------------- sync */

  useEffect(() => {
    if (!documentId) return;
    return syncChannel.onState((state, origin) => {
      if (state.documentId !== documentId || origin === deviceId) return;
      revRef.current = Math.max(revRef.current, state.rev);
      // Do not yank the page out from under someone who is reading; offer it.
      setHandoff(state);
    });
  }, [documentId]);

  const pushState = useCallback(
    (position: ReadingPosition, force: boolean) => {
      const doc = documentRef.current;
      if (!doc || !voiceId) return;

      const wordIndex = toGlobalWordIndex(doc.content, position);
      if (!shouldPushPosition(lastPushRef.current, wordIndex, Date.now(), { force })) return;
      lastPushRef.current = { wordIndex, atMs: Date.now() };

      api.putState(doc.meta.id, { position, speed: engine.getSpeed(), voiceId, rev: revRef.current })
        .then(({ state }) => {
          revRef.current = state.rev;
          setProgress(state.progress);
        })
        .catch(() => {
          // Offline: the next push will carry the newer position anyway.
        });
    },
    [engine, voiceId],
  );

  /** Flush the exact position when the tab is hidden or closed. */
  useEffect(() => {
    const flush = () => pushState(positionRef.current, true);
    const onVisibility = () => { if (window.document.visibilityState === 'hidden') flush(); };
    window.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [pushState]);

  /* ------------------------------------------------------------ controls */

  const reportWord = useCallback(
    (span: ActiveSpan) => {
      const doc = documentRef.current;
      if (!doc) return;
      const position = { blockIndex: span.blockIndex, tokenIndex: span.tokenIndex };
      positionRef.current = position;
      setProgress(progressAt(doc.content, position));
      pushState(position, false);
    },
    [pushState],
  );

  const play = useCallback(() => {
    void engine.play();
    pushState(positionRef.current, true);
  }, [engine, pushState]);

  const pause = useCallback(() => {
    engine.pause();
    pushState(positionRef.current, true);
  }, [engine, pushState]);

  const toggle = useCallback(() => {
    if (engine.snapshot().status === 'playing') pause();
    else play();
  }, [engine, pause, play]);

  const seekToMs = useCallback(
    (ms: number) => {
      void engine.seek(ms);
      const current = timeline;
      if (current) {
        positionRef.current = positionAtTime(current, ms);
        pushState(positionRef.current, true);
      }
    },
    [engine, pushState, timeline],
  );

  const seekToPosition = useCallback(
    (position: ReadingPosition) => {
      positionRef.current = position;
      if (timeline) void engine.seek(timeAtPosition(timeline, position));
      pushState(position, true);
    },
    [engine, pushState, timeline],
  );

  const skip = useCallback(
    (seconds: number) => {
      if (!timeline) return;
      seekToMs(Math.min(timeline.durationMs, Math.max(0, engine.currentMs() + seconds * 1000)));
    },
    [engine, seekToMs, timeline],
  );

  const skipSentence = useCallback(
    (delta: number) => {
      const doc = documentRef.current;
      if (!doc) return;
      seekToPosition(seekBySentence(doc.content, positionRef.current, delta));
    },
    [seekToPosition],
  );

  const setSpeed = useCallback(
    (speed: number) => {
      void engine.setSpeed(speed);
      pushState(positionRef.current, true);
    },
    [engine, pushState],
  );

  const setVoice = useCallback((next: string) => {
    setVoiceId(next);
    try { localStorage.setItem(VOICE_KEY, next); } catch { /* storage blocked */ }
    // The new voice has its own timeline; the effect above re-seats the engine
    // at the same word, which is exactly why positions are words not seconds.
    setTimeline(null);
  }, []);

  const acceptHandoff = useCallback(() => {
    const doc = documentRef.current;
    if (!handoff || !doc) return;
    seekToPosition(resumeTarget(doc.content, handoff.position));
    setHandoff(null);
  }, [handoff, seekToPosition]);

  const dismissHandoff = useCallback(() => setHandoff(null), []);

  /* --------------------------------------------------------- derived UI */

  useEffect(() => {
    const doc = documentRef.current;
    if (!doc || !timeline) return;
    // While playing, progress comes from the word events. While paused there are
    // none, so a scrubber seek is reflected here instead.
    if (rawPlayer.status !== 'playing') {
      const position = positionAtTime(timeline, rawPlayer.mediaMs);
      setProgress(progressAt(doc.content, position));
    }
  }, [rawPlayer.mediaMs, rawPlayer.status, timeline]);

  return {
    document, timeline, engine, player, voices, voiceId, synthesis, loading, error, progress, handoff,
    play, pause, toggle, seekToMs, seekToPosition, skip, skipSentence, setSpeed, setVoice,
    acceptHandoff, dismissHandoff, reportWord,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve the word a click landed on, used by "play from here". */
export function positionFromWordIndex(
  content: FullDocument['content'],
  globalWordIndex: number,
): ReadingPosition {
  return fromGlobalWordIndex(content, globalWordIndex);
}
