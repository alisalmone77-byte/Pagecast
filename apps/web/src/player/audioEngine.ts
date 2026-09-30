import { chunksToPrefetch, clampTime, type Timeline } from '@pagecast/core';

/**
 * Chunked playback on the Web Audio API.
 *
 * Why Web Audio rather than a plain `<audio>` element: the highlight has to
 * land on the right word, and `HTMLMediaElement.currentTime` is only updated a
 * few times a second and drifts across a chunk boundary. Web Audio schedules
 * sources against `AudioContext.currentTime`, a monotonic clock in the audio
 * thread, so the position can be computed for the exact instant a frame is
 * painted and the seam between two chunks is sample-accurate rather than an
 * audible gap.
 *
 * Position is derived, never polled:
 *
 *     mediaMs = anchorMediaMs + (ctx.currentTime - anchorContextTime) * 1000 * rate
 *
 * Both anchors are reset on every play, seek and rate change, which keeps the
 * derivation exact instead of accumulating error.
 */

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerSnapshot {
  readonly status: PlayerStatus;
  readonly mediaMs: number;
  readonly durationMs: number;
  readonly speed: number;
  readonly buffering: boolean;
  readonly error: string | null;
}

type Listener = (snapshot: PlayerSnapshot) => void;

interface ScheduledSource {
  readonly chunkIndex: number;
  readonly node: AudioBufferSourceNode;
}

/** Keep decoded audio for a window around the playhead; drop the rest. */
const MAX_CACHED_CHUNKS = 12;
/** Schedule this far ahead of the playhead, in media ms. */
const SCHEDULE_HORIZON_MS = 20_000;

export class AudioEngine {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;

  private timeline: Timeline | null = null;
  private readonly buffers = new Map<number, AudioBuffer>();
  private readonly pending = new Map<number, Promise<AudioBuffer | null>>();
  private sources: ScheduledSource[] = [];

  private status: PlayerStatus = 'idle';
  private speed = 1;
  private error: string | null = null;
  private buffering = false;

  /** Media position at the moment of the last anchor. */
  private anchorMediaMs = 0;
  /** `AudioContext.currentTime` at that same moment; null while paused. */
  private anchorContextTime: number | null = null;

  private readonly listeners = new Set<Listener>();
  private prefetchTimer: number | null = null;

  /* ------------------------------------------------------------ lifecycle */

  /** Load a timeline. Playback does not start until `play()` is called. */
  async load(timeline: Timeline, startMs = 0, speed = this.speed): Promise<void> {
    this.stopSources();
    this.timeline = timeline;
    this.speed = speed;
    this.anchorMediaMs = clampTime(timeline, startMs);
    this.anchorContextTime = null;
    this.error = null;
    this.setStatus(timeline.chunks.length > 0 ? 'paused' : 'loading');
    this.schedulePrefetch();
  }

  /**
   * Replace the timeline while keeping the current position.
   *
   * Used while a long document is still synthesising: the timeline grows chunk
   * by chunk, and the reader should not be interrupted each time it does.
   */
  updateTimeline(timeline: Timeline): void {
    const wasPlaying = this.status === 'playing';
    const position = this.currentMs();
    this.timeline = timeline;
    if (wasPlaying) {
      // Re-schedule against the longer timeline from where we actually are.
      void this.seek(position, true);
    } else {
      this.anchorMediaMs = Math.min(position, timeline.durationMs);
      this.emit();
    }
  }

  async play(): Promise<void> {
    const timeline = this.timeline;
    if (!timeline || timeline.chunks.length === 0) return;

    const ctx = this.ensureContext();
    // Browsers start the context suspended until a gesture resumes it.
    if (ctx.state === 'suspended') await ctx.resume();

    if (this.anchorMediaMs >= timeline.durationMs) this.anchorMediaMs = 0;

    this.anchorContextTime = ctx.currentTime;
    this.setStatus('playing');
    this.emit();
    await this.scheduleFrom(this.anchorMediaMs);
    this.schedulePrefetch();
  }

  pause(): void {
    if (this.status !== 'playing') return;
    this.anchorMediaMs = this.currentMs();
    this.anchorContextTime = null;
    this.stopSources();
    this.setStatus('paused');
  }

  async toggle(): Promise<void> {
    if (this.status === 'playing') this.pause();
    else await this.play();
  }

  /** Move the playhead. Resumes playing if it already was. */
  async seek(ms: number, keepPlaying = this.status === 'playing'): Promise<void> {
    const timeline = this.timeline;
    if (!timeline) return;

    const target = clampTime(timeline, ms);
    this.stopSources();
    this.anchorMediaMs = target;

    if (keepPlaying) {
      const ctx = this.ensureContext();
      if (ctx.state === 'suspended') await ctx.resume();
      this.anchorContextTime = ctx.currentTime;
      this.setStatus('playing');
      // setStatus is a no-op when already playing, so emit explicitly: the new
      // position has to reach the scrubber either way.
      this.emit();
      await this.scheduleFrom(target);
    } else {
      this.anchorContextTime = null;
      this.emit();
    }
    this.schedulePrefetch();
  }

  /**
   * Change the playback rate.
   *
   * The anchor is re-taken first, so the position already played is measured at
   * the old rate and everything after it at the new one. Without that, a speed
   * change mid-document would retroactively rescale the whole elapsed time and
   * jump the highlight.
   */
  async setSpeed(speed: number): Promise<void> {
    const next = Math.min(4.5, Math.max(0.5, speed));
    if (Math.abs(next - this.speed) < 0.001) return;

    const wasPlaying = this.status === 'playing';
    const position = this.currentMs();
    this.speed = next;

    // Emit before re-scheduling so the rate shown in the dock changes on the
    // same frame as the click, not once the next chunk has been scheduled.
    this.emit();

    if (wasPlaying) {
      await this.seek(position, true);
    } else {
      this.anchorMediaMs = position;
      this.emit();
    }
  }

  getSpeed(): number {
    return this.speed;
  }

  /** Current media position in ms, computed from the audio clock. */
  currentMs(): number {
    const timeline = this.timeline;
    if (!timeline) return 0;
    if (this.anchorContextTime === null || !this.context) return this.anchorMediaMs;

    const elapsed = (this.context.currentTime - this.anchorContextTime) * 1000 * this.speed;
    return Math.min(timeline.durationMs, this.anchorMediaMs + Math.max(0, elapsed));
  }

  snapshot(): PlayerSnapshot {
    return {
      status: this.status,
      mediaMs: this.currentMs(),
      durationMs: this.timeline?.durationMs ?? 0,
      speed: this.speed,
      buffering: this.buffering,
      error: this.error,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.stopSources();
    if (this.prefetchTimer !== null) clearTimeout(this.prefetchTimer);
    this.prefetchTimer = null;
    this.buffers.clear();
    this.pending.clear();
    this.listeners.clear();
    void this.context?.close();
    this.context = null;
  }

  /* -------------------------------------------------------------- internals */

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
    }
    return this.context;
  }

  /**
   * Schedule every chunk from `fromMs` out to the horizon.
   *
   * Each source is started at the context time its chunk is due, so the audio
   * thread stitches them together without the main thread being involved.
   */
  private async scheduleFrom(fromMs: number): Promise<void> {
    const timeline = this.timeline;
    const ctx = this.context;
    if (!timeline || !ctx || this.anchorContextTime === null) return;

    const horizon = fromMs + SCHEDULE_HORIZON_MS * this.speed;
    const due = timeline.chunks.filter(
      (chunk) => chunk.startMs + chunk.durationMs > fromMs && chunk.startMs <= horizon,
    );
    if (due.length === 0) {
      // Nothing synthesised here yet: wait for the timeline to grow.
      this.setBuffering(true);
      return;
    }

    const first = due[0]!;
    const firstBuffer = await this.loadChunk(first.index);
    // A seek during the await invalidates this scheduling pass.
    if (this.status !== 'playing' || this.anchorContextTime === null) return;
    if (!firstBuffer) {
      this.setBuffering(true);
      return;
    }
    this.setBuffering(false);

    // Where the playhead is *now*, not when this pass started, so the await
    // above does not cause a skip.
    const nowMs = this.currentMs();
    const offsetIntoFirst = Math.max(0, nowMs - first.startMs) / 1000;
    let when = ctx.currentTime + 0.02; // a beat of headroom for scheduling jitter

    if (offsetIntoFirst < firstBuffer.duration) {
      this.startSource(first.index, firstBuffer, when, offsetIntoFirst);
      when += (firstBuffer.duration - offsetIntoFirst) / this.speed;
    }

    for (const chunk of due.slice(1)) {
      const buffer = await this.loadChunk(chunk.index);
      if (this.status !== 'playing' || this.anchorContextTime === null) return;
      if (!buffer) break;
      this.startSource(chunk.index, buffer, when, 0);
      when += buffer.duration / this.speed;
    }
  }

  private startSource(chunkIndex: number, buffer: AudioBuffer, when: number, offset: number): void {
    const ctx = this.context;
    if (!ctx || !this.gain) return;

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = this.speed;
    node.connect(this.gain);
    node.start(when, offset);

    const entry: ScheduledSource = { chunkIndex, node };
    this.sources.push(entry);

    node.onended = () => {
      this.sources = this.sources.filter((s) => s !== entry);
      if (this.status !== 'playing') return;

      const timeline = this.timeline;
      if (!timeline) return;

      // The last scheduled source finished: either the document is over, or
      // the next chunk has not been synthesised yet.
      if (this.sources.length === 0) {
        const position = this.currentMs();
        if (position >= timeline.durationMs - 120) {
          this.anchorMediaMs = timeline.durationMs;
          this.anchorContextTime = null;
          this.setStatus('ended');
        } else {
          void this.scheduleFrom(position);
        }
      }
    };
  }

  private stopSources(): void {
    for (const source of this.sources) {
      source.node.onended = null;
      try {
        source.node.stop();
      } catch {
        // Already stopped; nothing to do.
      }
      source.node.disconnect();
    }
    this.sources = [];
  }

  /** Fetch and decode one chunk, de-duplicating concurrent requests. */
  private loadChunk(index: number): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(index);
    if (cached) return Promise.resolve(cached);

    const inFlight = this.pending.get(index);
    if (inFlight) return inFlight;

    const chunk = this.timeline?.chunks.find((c) => c.index === index);
    if (!chunk) return Promise.resolve(null);

    const task = (async (): Promise<AudioBuffer | null> => {
      try {
        const response = await fetch(chunk.url);
        if (!response.ok) throw new Error(`chunk ${index} returned ${response.status}`);
        const bytes = await response.arrayBuffer();
        const buffer = await this.ensureContext().decodeAudioData(bytes);
        this.buffers.set(index, buffer);
        this.evictDistantChunks(index);
        return buffer;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        this.emit();
        return null;
      } finally {
        this.pending.delete(index);
      }
    })();

    this.pending.set(index, task);
    return task;
  }

  /** Decoded audio is large; keep only a window around the playhead. */
  private evictDistantChunks(around: number): void {
    if (this.buffers.size <= MAX_CACHED_CHUNKS) return;
    const byDistance = [...this.buffers.keys()].sort(
      (a, b) => Math.abs(a - around) - Math.abs(b - around),
    );
    for (const index of byDistance.slice(MAX_CACHED_CHUNKS)) {
      this.buffers.delete(index);
    }
  }

  /**
   * Warm the chunks the reader is about to need.
   *
   * The lookahead widens with speed: at 4.5x a chunk is consumed four and a
   * half times faster, and a fixed window would run dry every time someone
   * sped up.
   */
  private schedulePrefetch(): void {
    if (this.prefetchTimer !== null) clearTimeout(this.prefetchTimer);
    this.prefetchTimer = window.setTimeout(() => {
      this.prefetchTimer = null;
      const timeline = this.timeline;
      if (!timeline) return;

      for (const index of chunksToPrefetch(timeline, this.currentMs(), this.speed)) {
        if (!this.buffers.has(index) && !this.pending.has(index)) void this.loadChunk(index);
      }
      if (this.status === 'playing') this.schedulePrefetch();
    }, 1_000);
  }

  private setStatus(status: PlayerStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit();
  }

  private setBuffering(buffering: boolean): void {
    if (this.buffering === buffering) return;
    this.buffering = buffering;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
