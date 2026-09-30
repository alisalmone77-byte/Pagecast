import type { ActiveSpan, AudioChunk, ReadingPosition, Timeline } from './types.js';

/**
 * Timeline lookups run on every animation frame, so both directions are
 * binary searches over the pre-sorted `words` array -- O(log n) on a 50-page
 * document is a handful of comparisons.
 */

/** Index into `timeline.words` of the word being spoken at `ms`. */
export function wordIndexAtTime(timeline: Timeline, ms: number): number {
  const { words } = timeline;
  if (words.length === 0) return -1;
  if (ms <= words[0]!.startMs) return 0;

  let lo = 0;
  let hi = words.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid]!.startMs <= ms) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Media time at which `position` is spoken. */
export function timeAtPosition(timeline: Timeline, position: ReadingPosition): number {
  const { words } = timeline;
  if (words.length === 0) return 0;

  let lo = 0;
  let hi = words.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = words[mid]!;
    const before =
      w.blockIndex < position.blockIndex ||
      (w.blockIndex === position.blockIndex && w.tokenIndex < position.tokenIndex);
    if (before) {
      lo = mid + 1;
    } else {
      best = mid;
      hi = mid - 1;
    }
  }
  if (best === -1) return timeline.durationMs;
  return words[best]!.startMs;
}

/** The position being spoken at `ms`. */
export function positionAtTime(timeline: Timeline, ms: number): ReadingPosition {
  const i = wordIndexAtTime(timeline, ms);
  const word = timeline.words[i];
  if (!word) return { blockIndex: 0, tokenIndex: 0 };
  return { blockIndex: word.blockIndex, tokenIndex: word.tokenIndex };
}

/** Everything the reader view needs to paint the highlight for one frame. */
export function activeSpanAtTime(timeline: Timeline, ms: number): ActiveSpan | null {
  const wordIndex = wordIndexAtTime(timeline, ms);
  const word = timeline.words[wordIndex];
  if (!word) return null;

  const span = Math.max(1, word.endMs - word.startMs);
  const wordProgress = Math.min(1, Math.max(0, (ms - word.startMs) / span));

  return {
    wordIndex,
    sentenceIndex: sentenceIndexOfWord(timeline, wordIndex),
    blockIndex: word.blockIndex,
    tokenIndex: word.tokenIndex,
    wordProgress,
  };
}

/** Which sentence a word index falls in, via the timeline's sentence start index. */
export function sentenceIndexOfWord(timeline: Timeline, wordIndex: number): number {
  const starts = timeline.sentenceStarts;
  if (starts.length === 0) return -1;

  let lo = 0;
  let hi = starts.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= wordIndex) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** The chunk containing `ms`, or null past the end of the document. */
export function chunkAtTime(timeline: Timeline, ms: number): AudioChunk | null {
  for (const chunk of timeline.chunks) {
    if (ms >= chunk.startMs && ms < chunk.startMs + chunk.durationMs) return chunk;
  }
  return timeline.chunks[timeline.chunks.length - 1] ?? null;
}

/**
 * Chunks worth having in memory at `ms`, given the playback rate.
 *
 * At 4.5x a chunk is consumed four and a half times faster, so the lookahead
 * has to widen with speed or the reader hits a gap every time they speed up.
 */
export function chunksToPrefetch(timeline: Timeline, ms: number, speed: number, lookaheadMs = 30_000): number[] {
  const horizon = ms + lookaheadMs * Math.max(1, speed);
  const wanted: number[] = [];
  for (const chunk of timeline.chunks) {
    const end = chunk.startMs + chunk.durationMs;
    if (end >= ms && chunk.startMs <= horizon) wanted.push(chunk.index);
  }
  return wanted;
}

/** Clamp a seek to the playable range. */
export function clampTime(timeline: Timeline, ms: number): number {
  return Math.min(Math.max(0, ms), timeline.durationMs);
}

/**
 * Skip forward/back by a number of seconds of *media* time.
 *
 * Deliberately not scaled by the playback rate: a 15-second skip means the same
 * amount of content whatever speed you are at, which is the behaviour every
 * podcast player has trained readers to expect.
 */
export function skipSeconds(timeline: Timeline, ms: number, seconds: number): number {
  return clampTime(timeline, ms + seconds * 1000);
}
