import type { AudioChunk, DocumentContent, Timeline, WordTiming } from './types.js';

/**
 * Timing has two sources, in order of preference:
 *
 *  1. Word boundary marks from the TTS provider (Azure, Polly and friends emit
 *     these). Exact, and `Timeline.precise` is set.
 *  2. An estimate, normalised so the estimated chunk duration matches the audio
 *     file's real duration. Individual words drift by tens of milliseconds, but
 *     the error never accumulates across a chunk, so highlighting stays locked
 *     to the audio over a 50-page document.
 *
 * Either way the output is the same `Timeline`, and nothing downstream needs to
 * know which one produced it.
 */

/** Pause added *after* a word, in ms at 1.0x, keyed by the punctuation that follows it. */
const PAUSE_COMMA = 90;
const PAUSE_CLAUSE = 160; // ; : -- ( )
const PAUSE_SENTENCE = 300;
const PAUSE_PARAGRAPH = 520;

/** Rough syllable count. Cheap, and good enough to weight relative word lengths. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 1;
  if (w.length <= 3) return 1;
  const groups = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
    .match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/**
 * Relative cost of speaking one word, in arbitrary units. Digits are expanded
 * because "2024" is spoken as several syllables but written as four characters.
 */
export function wordCost(word: string): number {
  if (/^\p{N}+$/u.test(word)) return Math.max(1, word.length) * 1.4;
  return syllables(word);
}

export interface TimingPlanEntry {
  readonly blockIndex: number;
  readonly tokenIndex: number;
  /** The word itself, so a provider can mark it up without re-reading the block. */
  readonly text: string;
  /** Unitless speaking cost. */
  readonly cost: number;
  /** Silence that follows this word, in ms. */
  readonly pauseMs: number;
}

/**
 * Walk a sentence range and produce the per-word cost/pause plan used to
 * estimate timings. Exported so the API can build a plan once per chunk.
 */
export function planSentences(
  content: DocumentContent,
  startSentence: number,
  endSentence: number,
): TimingPlanEntry[] {
  const plan: TimingPlanEntry[] = [];
  for (let s = startSentence; s < endSentence; s += 1) {
    const sentence = content.sentences[s];
    if (!sentence) continue;
    const block = content.blocks[sentence.blockIndex];
    if (!block) continue;

    for (let t = sentence.startToken; t < sentence.endToken; t += 1) {
      const token = block.tokens[t];
      if (!token) continue;
      const next = block.tokens[t + 1];
      const gap = block.text.slice(token.end, next ? next.start : block.text.length);

      let pauseMs = 0;
      const lastOfSentence = t === sentence.endToken - 1;
      const lastOfBlock = t === block.tokens.length - 1;
      const nextSentence = content.sentences[s + 1];
      const blockChanges = lastOfBlock || (lastOfSentence && nextSentence?.blockIndex !== sentence.blockIndex);

      if (lastOfSentence && blockChanges) pauseMs = PAUSE_PARAGRAPH;
      else if (lastOfSentence) pauseMs = PAUSE_SENTENCE;
      else if (/,/.test(gap)) pauseMs = PAUSE_COMMA;
      else if (/[;:—–()\[\]]/.test(gap)) pauseMs = PAUSE_CLAUSE;

      plan.push({
        blockIndex: block.index,
        tokenIndex: t,
        text: token.text,
        cost: wordCost(token.text),
        pauseMs,
      });
    }
  }
  return plan;
}

/**
 * Turn a plan into word timings that exactly fill `durationMs`.
 *
 * Pauses are taken off the top and the remaining time is shared out in
 * proportion to speaking cost, so the fit is exact however wrong the per-word
 * estimate was. A word's `endMs` runs up to the start of the next word, pause
 * included, so a highlight does not blink off during a comma.
 */
export function fitPlan(plan: readonly TimingPlanEntry[], durationMs: number, offsetMs = 0): WordTiming[] {
  if (plan.length === 0) return [];

  const totalCost = plan.reduce((sum, e) => sum + e.cost, 0);
  const totalPause = plan.reduce((sum, e) => sum + e.pauseMs, 0);

  // If the real audio is shorter than the pauses alone, scale the pauses down
  // rather than producing negative speaking time.
  const pauseScale = totalPause > 0 ? Math.min(1, (durationMs * 0.35) / totalPause) : 0;
  const scaledPause = totalPause * pauseScale;
  const speakMs = Math.max(0, durationMs - scaledPause);
  const msPerCost = totalCost > 0 ? speakMs / totalCost : 0;

  const out: WordTiming[] = [];
  let cursor = offsetMs;
  for (let i = 0; i < plan.length; i += 1) {
    const entry = plan[i]!;
    const spoken = entry.cost * msPerCost;
    const pause = entry.pauseMs * pauseScale;
    const start = cursor;
    // Extend the highlight through the trailing pause, but not through a
    // paragraph break -- there the eye should be free to move on.
    const hold = entry.pauseMs >= PAUSE_PARAGRAPH ? 0 : pause;
    out.push({
      blockIndex: entry.blockIndex,
      tokenIndex: entry.tokenIndex,
      startMs: Math.round(start),
      endMs: Math.round(start + spoken + hold),
    });
    cursor = start + spoken + pause;
  }

  // Absorb rounding drift into the final word so the timeline ends exactly on
  // the audio duration.
  const last = out[out.length - 1];
  if (last) out[out.length - 1] = { ...last, endMs: Math.max(last.startMs, Math.round(offsetMs + durationMs)) };
  return out;
}

/** A word boundary reported by a TTS provider, relative to the start of its chunk. */
export interface ProviderMark {
  readonly blockIndex: number;
  readonly tokenIndex: number;
  readonly startMs: number;
  readonly endMs?: number;
}

/** Convert provider marks for one chunk into absolute word timings. */
export function marksToTimings(
  marks: readonly ProviderMark[],
  chunkDurationMs: number,
  offsetMs: number,
): WordTiming[] {
  const out: WordTiming[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i]!;
    const next = marks[i + 1];
    const end = mark.endMs ?? (next ? next.startMs : chunkDurationMs);
    out.push({
      blockIndex: mark.blockIndex,
      tokenIndex: mark.tokenIndex,
      startMs: Math.round(offsetMs + mark.startMs),
      endMs: Math.round(offsetMs + Math.max(mark.startMs, end)),
    });
  }
  return out;
}

export interface ChunkTiming {
  readonly chunk: AudioChunk;
  readonly words: readonly WordTiming[];
}

/** Assemble per-chunk timings into one document-wide timeline. */
export function buildTimeline(
  voiceId: string,
  parts: readonly ChunkTiming[],
  content: DocumentContent,
  precise: boolean,
): Timeline {
  const chunks = parts.map((p) => p.chunk);
  const words: WordTiming[] = [];
  for (const part of parts) words.push(...part.words);
  words.sort((a, b) => a.startMs - b.startMs);

  // Index the first word of every sentence so the reader can jump by sentence.
  const sentenceStarts: number[] = [];
  let cursor = 0;
  for (const sentence of content.sentences) {
    while (
      cursor < words.length &&
      !isAtOrAfter(words[cursor]!, sentence.blockIndex, sentence.startToken)
    ) {
      cursor += 1;
    }
    sentenceStarts.push(Math.min(cursor, Math.max(0, words.length - 1)));
  }

  const lastChunk = chunks[chunks.length - 1];
  const durationMs = lastChunk ? lastChunk.startMs + lastChunk.durationMs : 0;
  return { voiceId, durationMs, chunks, words, sentenceStarts, precise };
}

function isAtOrAfter(word: WordTiming, blockIndex: number, tokenIndex: number): boolean {
  if (word.blockIndex !== blockIndex) return word.blockIndex > blockIndex;
  return word.tokenIndex >= tokenIndex;
}
