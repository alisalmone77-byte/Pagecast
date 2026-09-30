import type { DocumentContent, ReadingPosition, Sentence } from './types.js';

/** Clamp a position onto a real word of a real block. */
export function clampPosition(content: DocumentContent, position: ReadingPosition): ReadingPosition {
  const { blocks } = content;
  if (blocks.length === 0) return { blockIndex: 0, tokenIndex: 0 };

  const blockIndex = Math.min(Math.max(0, position.blockIndex), blocks.length - 1);
  const block = blocks[blockIndex]!;
  const tokenIndex = Math.min(Math.max(0, position.tokenIndex), Math.max(0, block.tokens.length - 1));
  return { blockIndex, tokenIndex };
}

/** Compare two positions in reading order. */
export function comparePositions(a: ReadingPosition, b: ReadingPosition): number {
  if (a.blockIndex !== b.blockIndex) return a.blockIndex - b.blockIndex;
  return a.tokenIndex - b.tokenIndex;
}

/** Running word count at the start of each block; index `blocks.length` is the total. */
export function blockWordOffsets(content: DocumentContent): number[] {
  const offsets: number[] = [0];
  let total = 0;
  for (const block of content.blocks) {
    total += block.tokens.length;
    offsets.push(total);
  }
  return offsets;
}

/** Flatten a position to a single index over every word in the document. */
export function toGlobalWordIndex(content: DocumentContent, position: ReadingPosition): number {
  const p = clampPosition(content, position);
  let n = 0;
  for (let b = 0; b < p.blockIndex; b += 1) n += content.blocks[b]!.tokens.length;
  return n + p.tokenIndex;
}

/** Inverse of {@link toGlobalWordIndex}. */
export function fromGlobalWordIndex(content: DocumentContent, globalIndex: number): ReadingPosition {
  let remaining = Math.max(0, globalIndex);
  for (const block of content.blocks) {
    if (remaining < block.tokens.length) {
      return { blockIndex: block.index, tokenIndex: remaining };
    }
    remaining -= block.tokens.length;
  }
  const last = content.blocks[content.blocks.length - 1];
  if (!last) return { blockIndex: 0, tokenIndex: 0 };
  return { blockIndex: last.index, tokenIndex: Math.max(0, last.tokens.length - 1) };
}

/**
 * Fraction of the document read, 0..1.
 *
 * The denominator is the number of *gaps* between words, not the word count,
 * so the first word reads 0 and the last word reads exactly 1. Dividing by the
 * word count instead would leave a reader who has reached the final word of a
 * 24-word document sitting at 96%, and a document that can never be finished
 * never leaves the "continue listening" shelf.
 */
export function progressAt(content: DocumentContent, position: ReadingPosition): number {
  const total = blockWordOffsets(content)[content.blocks.length] ?? 0;
  if (total <= 1) return 0;
  return Math.min(1, Math.max(0, toGlobalWordIndex(content, position) / (total - 1)));
}

/** Index of the sentence containing `position`, or -1 if the document is empty. */
export function sentenceAtPosition(content: DocumentContent, position: ReadingPosition): number {
  const p = clampPosition(content, position);
  let lo = 0;
  let hi = content.sentences.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = content.sentences[mid]!;
    if (s.blockIndex < p.blockIndex || (s.blockIndex === p.blockIndex && s.startToken <= p.tokenIndex)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Where playback should actually start when a reader resumes.
 *
 * Dropping back to the beginning of the sentence costs a couple of seconds and
 * restores the context a listener lost when they stopped, which matters more
 * for comprehension than resuming on the exact syllable.
 */
export function resumeTarget(content: DocumentContent, position: ReadingPosition): ReadingPosition {
  const sentenceIndex = sentenceAtPosition(content, position);
  const sentence: Sentence | undefined = content.sentences[sentenceIndex];
  if (!sentence) return clampPosition(content, position);
  return { blockIndex: sentence.blockIndex, tokenIndex: sentence.startToken };
}

/** First word of the sentence `delta` sentences away -- powers skip-by-section gestures. */
export function seekBySentence(
  content: DocumentContent,
  position: ReadingPosition,
  delta: number,
): ReadingPosition {
  const current = sentenceAtPosition(content, position);
  if (current < 0) return clampPosition(content, position);
  const target = Math.min(content.sentences.length - 1, Math.max(0, current + delta));
  const sentence = content.sentences[target];
  if (!sentence) return clampPosition(content, position);
  return { blockIndex: sentence.blockIndex, tokenIndex: sentence.startToken };
}

/** Human-readable remaining time at a given speed, in seconds. */
export function remainingSeconds(
  content: DocumentContent,
  position: ReadingPosition,
  wordsPerMinute: number,
  speed: number,
): number {
  const total = blockWordOffsets(content)[content.blocks.length] ?? 0;
  const read = toGlobalWordIndex(content, position);
  const wpm = Math.max(1, wordsPerMinute * Math.max(0.1, speed));
  return Math.max(0, ((total - read) / wpm) * 60);
}
