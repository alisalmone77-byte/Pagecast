import type { Block, BlockType, DocumentContent, Sentence, Token } from './types.js';

/**
 * Word characters: letters (any script), digits, and the marks that live
 * *inside* a word rather than between words -- straight and curly apostrophes,
 * and the hyphen in "well-known". A trailing hyphen or apostrophe is trimmed
 * afterwards so "wait -" does not swallow the dash.
 */
const WORD_RE = /[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu;

/**
 * Abbreviations whose trailing period does not end a sentence. Compared
 * lower-cased and without the period.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'rev', 'hon', 'pres', 'gen', 'col', 'lt', 'sgt',
  'capt', 'cmdr', 'adm', 'gov', 'sen', 'rep', 'atty', 'supt', 'det', 'insp',
  'e.g', 'i.e', 'etc', 'vs', 'viz', 'cf', 'al', 'ibid', 'op', 'cit', 'esp', 'approx', 'est',
  'fig', 'figs', 'eq', 'eqs', 'ref', 'refs', 'ch', 'chap', 'sec', 'vol', 'vols',
  'pp', 'p', 'ed', 'eds', 'trans', 'dept', 'univ', 'inst', 'assn', 'corp', 'inc', 'ltd', 'co',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'a.m', 'p.m', 'u.s', 'u.k', 'u.n', 'd.c', 'ph.d', 'm.d', 'b.a', 'm.a', 'b.s', 'm.s',
]);

/** Split a block's text into word tokens, preserving character offsets. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text)) !== null) {
    let raw = m[0];
    let start = m.index;
    // Trim connector characters that ended up on an edge.
    while (raw.length > 0 && /[’'\-]/.test(raw[0]!)) {
      raw = raw.slice(1);
      start += 1;
    }
    while (raw.length > 0 && /[’'\-]/.test(raw[raw.length - 1]!)) raw = raw.slice(0, -1);
    if (raw.length === 0) continue;
    tokens.push({ i: tokens.length, text: raw, start, end: start + raw.length });
  }
  return tokens;
}

/** Heuristically classify a paragraph of plain text. */
function classify(line: string): BlockType {
  const md = /^(#{1,6})\s+/.exec(line);
  if (md) {
    const level = md[1]!.length;
    return level === 1 ? 'heading1' : level === 2 ? 'heading2' : 'heading3';
  }
  if (/^\s*(?:[-*•‣▪]|\d{1,3}[.)])\s+/.test(line)) return 'listItem';
  if (/^\s*>\s?/.test(line)) return 'quote';
  if (/^\s{4,}\S/.test(line) && !/[.!?]$/.test(line.trim())) return 'code';

  const trimmed = line.trim();
  // A short line with no terminal punctuation reads as a heading.
  if (trimmed.length > 0 && trimmed.length <= 80 && !/[.!?:;,]$/.test(trimmed)) {
    const words = trimmed.split(/\s+/);
    if (words.length <= 12) {
      const isAllCaps = trimmed === trimmed.toUpperCase() && /\p{L}/u.test(trimmed);
      const isTitleCase = words.filter((w) => /^[\p{Lu}]/u.test(w)).length >= Math.ceil(words.length * 0.6);
      if (isAllCaps || isTitleCase) return 'heading2';
    }
  }
  return 'paragraph';
}

/** Strip the markup that only signalled the block's type. */
function stripMarker(line: string, type: BlockType): string {
  switch (type) {
    case 'heading1':
    case 'heading2':
    case 'heading3':
      return line.replace(/^#{1,6}\s+/, '').trim();
    case 'listItem':
      return line.replace(/^\s*(?:[-*•‣▪]|\d{1,3}[.)])\s+/, '').trim();
    case 'quote':
      return line.replace(/^\s*>\s?/gm, '').trim();
    default:
      return line.trim();
  }
}

/**
 * Split plain text into blocks. A blank line always starts a new block; inside
 * a run of non-blank lines, single newlines are treated as soft wraps and
 * joined, which is what PDF and OCR extraction produce.
 */
export function blocksFromText(text: string): Block[] {
  const normalised = text.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  const chunks = normalised.split(/\n\s*\n+/);
  const blocks: Block[] = [];

  for (const chunk of chunks) {
    const lines = chunk.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    // List items and headings stay one block per line; prose is re-flowed.
    const groups: string[] = [];
    let buffer: string[] = [];
    const flush = () => {
      if (buffer.length > 0) {
        groups.push(buffer.join(' '));
        buffer = [];
      }
    };
    for (const line of lines) {
      const t = classify(line);
      if (t === 'listItem' || t === 'heading1' || t === 'heading2' || t === 'heading3') {
        flush();
        groups.push(line);
      } else {
        // A hyphen at a line break is a split word in PDF/OCR text: rejoin it.
        const prev = buffer[buffer.length - 1];
        if (prev !== undefined && /[\p{L}]-$/u.test(prev)) {
          buffer[buffer.length - 1] = prev.slice(0, -1) + line.trimStart();
        } else {
          buffer.push(line.trim());
        }
      }
    }
    flush();

    for (const group of groups) {
      const type = classify(group);
      const body = stripMarker(group, type).replace(/\s+/g, ' ').trim();
      if (body.length === 0) continue;
      const tokens = tokenize(body);
      if (tokens.length === 0) continue;
      blocks.push({ index: blocks.length, type, text: body, tokens });
    }
  }
  return blocks;
}

/** True when the period ending `token` is part of an abbreviation, not a sentence. */
function isAbbreviation(word: string): boolean {
  const stripped = word.replace(/[^\p{L}\p{N}.]/gu, '').replace(/\.$/, '');
  if (ABBREVIATIONS.has(stripped.toLowerCase())) return true;
  // Single initials: "J. R. R. Tolkien". Restricted to capitals, because a
  // lowercase single letter before a period is far more often the tail of a
  // split abbreviation that genuinely ends the sentence -- the "m" of "3 p.m."
  if (/^\p{Lu}$/u.test(stripped)) return true;
  // Dotted acronyms: "U.S.A."
  if (/^(?:\p{L}\.){2,}$/u.test(word.toLowerCase())) return true;
  return false;
}

/**
 * Split one block into sentences, returned as token ranges.
 *
 * Works on the raw text so it can see the punctuation that tokenization drops,
 * then maps each boundary back onto a token index.
 */
export function sentenceRanges(block: Block): Array<{ startToken: number; endToken: number }> {
  const { text, tokens } = block;
  if (tokens.length === 0) return [];
  // Headings and code are single units: never split them mid-line.
  if (block.type !== 'paragraph' && block.type !== 'quote' && block.type !== 'listItem') {
    return [{ startToken: 0, endToken: tokens.length }];
  }

  const ranges: Array<{ startToken: number; endToken: number }> = [];
  let startToken = 0;

  for (let t = 0; t < tokens.length; t += 1) {
    const token = tokens[t]!;
    // Look at the characters between this token and the next one.
    const next = tokens[t + 1];
    const gapStart = token.end;
    const gapEnd = next ? next.start : text.length;
    const gap = text.slice(gapStart, gapEnd);

    const terminator = /[.!?…]/.exec(gap);
    if (!terminator) continue;

    // Everything after the terminator must be closing quotes/brackets, further
    // terminators or whitespace -- so `he said "Stop!"` still ends here.
    const after = gap.slice(terminator.index + 1);
    if (!/^[\s"'”’)\]}»›.!?…]*$/.test(after)) continue;

    if (terminator[0] === '.' && isAbbreviation(token.text + '.')) continue;

    // A decimal point: "3.14" -- the gap is exactly "." and the next token is a number.
    if (terminator[0] === '.' && gap.trim() === '.' && next && /^\p{N}/u.test(next.text) && /\p{N}$/u.test(token.text)) {
      continue;
    }

    // If the sentence would not be followed by a capital letter or a new block,
    // it is more likely mid-sentence punctuation than a real boundary.
    if (next && terminator[0] === '.') {
      const first = next.text[0]!;
      const startsUpper = first === first.toUpperCase() && /\p{L}/u.test(first);
      const startsNumber = /\p{N}/u.test(first);
      if (!startsUpper && !startsNumber) continue;
    }

    ranges.push({ startToken, endToken: t + 1 });
    startToken = t + 1;
  }

  if (startToken < tokens.length) ranges.push({ startToken, endToken: tokens.length });
  return ranges;
}

/** Build the full parsed content -- blocks plus a flat, ordered sentence list. */
export function buildContent(blocks: readonly Block[]): DocumentContent {
  const sentences: Sentence[] = [];
  for (const block of blocks) {
    for (const r of sentenceRanges(block)) {
      sentences.push({
        index: sentences.length,
        blockIndex: block.index,
        startToken: r.startToken,
        endToken: r.endToken,
      });
    }
  }
  return { blocks, sentences };
}

/** Parse plain text straight through to renderable, speakable content. */
export function parseText(text: string): DocumentContent {
  return buildContent(blocksFromText(text));
}

/** The exact words a sentence covers, as spoken. */
export function sentenceText(content: DocumentContent, sentenceIndex: number): string {
  const s = content.sentences[sentenceIndex];
  if (!s) return '';
  const block = content.blocks[s.blockIndex];
  if (!block) return '';
  const first = block.tokens[s.startToken];
  const last = block.tokens[s.endToken - 1];
  if (!first || !last) return '';
  return block.text.slice(first.start, last.end);
}

export function totalWords(content: DocumentContent): number {
  let n = 0;
  for (const b of content.blocks) n += b.tokens.length;
  return n;
}
