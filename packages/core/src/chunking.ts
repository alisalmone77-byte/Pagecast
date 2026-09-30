import type { DocumentContent } from './types.js';
import { wordCost } from './timing.js';

/**
 * How a document is cut into synthesis units.
 *
 * Chunks exist so playback can start before the whole document is synthesised,
 * and so a client downloads only what it is about to play. The constraints:
 *
 *  - Never split a sentence. A cut mid-sentence is audible as a swallowed word
 *    at the seam, because TTS prosody does not line up across two requests.
 *  - Prefer to cut at a paragraph boundary, where a breath is expected anyway.
 *  - Keep chunks small enough that the first one is quick to synthesise, and
 *    large enough that prosody has room and request overhead stays low.
 */

/** Target spoken length of a chunk, in seconds at 1.0x. */
const TARGET_SECONDS = 45;
/** Never exceed this, even if it means cutting mid-paragraph. */
const MAX_SECONDS = 75;
/** Words per minute assumed when turning speaking cost into seconds. */
const ASSUMED_WPM = 165;

export interface ChunkPlan {
  readonly index: number;
  /** Half-open range of sentence indices. */
  readonly startSentence: number;
  readonly endSentence: number;
  /** Estimated spoken length at 1.0x, used only to size the chunk. */
  readonly estimatedMs: number;
  readonly text: string;
}

/** Estimated milliseconds to speak one sentence at 1.0x. */
function sentenceMs(content: DocumentContent, sentenceIndex: number): number {
  const sentence = content.sentences[sentenceIndex];
  if (!sentence) return 0;
  const block = content.blocks[sentence.blockIndex];
  if (!block) return 0;
  let cost = 0;
  for (let t = sentence.startToken; t < sentence.endToken; t += 1) {
    const token = block.tokens[t];
    if (token) cost += wordCost(token.text);
  }
  // wordCost is in syllables; ~1.45 syllables per word on average English prose.
  const words = cost / 1.45;
  return (words / ASSUMED_WPM) * 60_000;
}

/** The literal text handed to the TTS provider for a sentence range. */
export function chunkText(content: DocumentContent, startSentence: number, endSentence: number): string {
  const parts: string[] = [];
  let lastBlock = -1;
  for (let s = startSentence; s < endSentence; s += 1) {
    const sentence = content.sentences[s];
    if (!sentence) continue;
    const block = content.blocks[sentence.blockIndex];
    if (!block) continue;
    const first = block.tokens[sentence.startToken];
    const last = block.tokens[sentence.endToken - 1];
    if (!first || !last) continue;

    // Include the punctuation that follows the final token: the provider needs
    // it to get the prosody of a question or an exclamation right.
    let end = last.end;
    while (end < block.text.length && /[.!?…,;:"'”’)\]]/.test(block.text[end]!)) end += 1;

    const text = block.text.slice(first.start, end).trim();
    if (text.length === 0) continue;
    // A paragraph change becomes a blank line, which most providers read as a
    // longer pause than a sentence break.
    parts.push(sentence.blockIndex !== lastBlock && lastBlock !== -1 ? `\n\n${text}` : text);
    lastBlock = sentence.blockIndex;
  }
  return parts.join(' ').replace(/ \n\n/g, '\n\n');
}

/** Cut a document into synthesis chunks. */
export function planChunks(content: DocumentContent): ChunkPlan[] {
  const plans: ChunkPlan[] = [];
  const total = content.sentences.length;
  if (total === 0) return plans;

  const targetMs = TARGET_SECONDS * 1000;
  const maxMs = MAX_SECONDS * 1000;

  let start = 0;
  let accumulated = 0;
  let lastParagraphEnd = -1;

  for (let s = 0; s < total; s += 1) {
    accumulated += sentenceMs(content, s);
    const current = content.sentences[s]!;
    const next = content.sentences[s + 1];
    const paragraphEndsHere = !next || next.blockIndex !== current.blockIndex;
    if (paragraphEndsHere) lastParagraphEnd = s;

    const atEnd = s === total - 1;
    const overTarget = accumulated >= targetMs;
    const overMax = accumulated >= maxMs;

    if (atEnd) {
      plans.push(makePlan(content, plans.length, start, total));
      break;
    }
    if (overTarget && paragraphEndsHere) {
      plans.push(makePlan(content, plans.length, start, s + 1));
      start = s + 1;
      accumulated = 0;
      continue;
    }
    if (overMax) {
      // Past the hard limit with no paragraph break in sight -- fall back to the
      // last one we passed, or cut at this sentence if there wasn't one.
      const cut = lastParagraphEnd >= start ? lastParagraphEnd + 1 : s + 1;
      plans.push(makePlan(content, plans.length, start, cut));
      start = cut;
      accumulated = 0;
      for (let k = cut; k <= s; k += 1) accumulated += sentenceMs(content, k);
    }
  }
  return plans;
}

function makePlan(content: DocumentContent, index: number, startSentence: number, endSentence: number): ChunkPlan {
  let estimatedMs = 0;
  for (let s = startSentence; s < endSentence; s += 1) estimatedMs += sentenceMs(content, s);
  return {
    index,
    startSentence,
    endSentence,
    estimatedMs: Math.round(estimatedMs),
    text: chunkText(content, startSentence, endSentence),
  };
}
