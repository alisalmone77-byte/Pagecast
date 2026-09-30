import type { Extracted } from './types.js';

/**
 * PDF text extraction via pdf.js.
 *
 * PDFs carry no paragraph structure -- only positioned glyph runs -- so the
 * structure has to be inferred from geometry. Two signals do most of the work:
 *
 *  - A vertical gap larger than the running line height means a paragraph
 *    break rather than a wrapped line.
 *  - A line whose first glyph is indented relative to the column's left edge
 *    also starts a paragraph, which is how most typeset prose marks them.
 *
 * Headers and footers are dropped by finding short lines that repeat at the
 * same vertical position on many pages -- running heads and page numbers --
 * because reading "Journal of Cognitive Science, Vol 12" aloud between every
 * page is exactly the fatigue this product exists to remove.
 */

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

interface Line {
  text: string;
  x: number;
  y: number;
  height: number;
}

let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;

async function loadPdfjs() {
  if (!pdfjsPromise) {
    // The legacy build is the one that runs under Node without a DOM.
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

export async function extractPdf(bytes: Buffer): Promise<Extracted> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    // No canvas in Node, and neither is needed for text.
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise;

  try {
    const pages: Line[][] = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push(groupIntoLines(content.items as unknown as TextItem[]));
      page.cleanup();
    }

    const furniture = findRunningHeadsAndFeet(pages);
    const paragraphs: string[] = [];
    for (const lines of pages) {
      const body = lines.filter((line) => !furniture.has(furnitureKey(line)));
      paragraphs.push(...linesToParagraphs(body));
    }

    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as { Title?: string; Author?: string };

    return {
      text: joinParagraphs(paragraphs),
      title: cleanMeta(info.Title),
      author: cleanMeta(info.Author),
      pageCount: doc.numPages,
    };
  } finally {
    await doc.destroy();
  }
}

/** Group positioned glyph runs into visual lines by their baseline. */
function groupIntoLines(items: readonly TextItem[]): Line[] {
  const lines: Line[] = [];
  let current: { parts: string[]; x: number; y: number; height: number; lastEnd: number } | null = null;

  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const height = Math.abs(item.transform[3] ?? item.height ?? 12) || 12;
    if (item.str.trim().length === 0 && current === null) continue;

    // Same baseline, within a fraction of the glyph height, is the same line.
    const sameLine = current !== null && Math.abs(current.y - y) <= Math.max(2, height * 0.4);
    if (!sameLine) {
      if (current) lines.push(finishLine(current));
      current = { parts: [], x, y, height, lastEnd: x };
    }
    if (!current) continue;

    // Insert a space when the horizontal gap is wider than the glyphs are tall,
    // which is how word spacing survives when the PDF emits runs without spaces.
    const gap = x - current.lastEnd;
    const needsSpace =
      current.parts.length > 0 &&
      gap > height * 0.2 &&
      !/\s$/.test(current.parts[current.parts.length - 1] ?? '') &&
      !item.str.startsWith(' ');
    if (needsSpace) current.parts.push(' ');

    current.parts.push(item.str);
    current.x = Math.min(current.x, x);
    current.lastEnd = x + (item.width ?? 0);
  }
  if (current) lines.push(finishLine(current));
  return lines.filter((l) => l.text.length > 0);
}

function finishLine(current: { parts: string[]; x: number; y: number; height: number }): Line {
  return {
    text: current.parts.join('').replace(/\s+/g, ' ').trim(),
    x: current.x,
    y: current.y,
    height: current.height,
  };
}

/** A running head/foot is identified by its text and its vertical position. */
function furnitureKey(line: Line): string {
  return `${Math.round(line.y / 4)}:${line.text.replace(/\d+/g, '#')}`;
}

/**
 * Lines that repeat at the same height across a third or more of the pages are
 * furniture. Page numbers vary, so digits are masked before comparing.
 */
function findRunningHeadsAndFeet(pages: readonly Line[][]): Set<string> {
  const furniture = new Set<string>();
  if (pages.length < 4) return furniture;

  const counts = new Map<string, number>();
  for (const lines of pages) {
    // Only the top and bottom two lines of a page can be furniture.
    const edges = [...lines.slice(0, 2), ...lines.slice(-2)];
    const seen = new Set<string>();
    for (const line of edges) {
      if (line.text.length > 90) continue;
      const key = furnitureKey(line);
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const threshold = Math.max(3, Math.floor(pages.length / 3));
  for (const [key, count] of counts) {
    if (count >= threshold) furniture.add(key);
  }
  return furniture;
}

/** Fold visual lines into paragraphs using vertical gaps and indentation. */
function linesToParagraphs(lines: readonly Line[]): string[] {
  if (lines.length === 0) return [];

  // The typical line-to-line step for this page, used as the gap baseline.
  const steps: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const step = Math.abs(lines[i - 1]!.y - lines[i]!.y);
    if (step > 0 && step < 200) steps.push(step);
  }
  steps.sort((a, b) => a - b);
  const medianStep = steps.length > 0 ? steps[Math.floor(steps.length / 2)]! : 14;

  // The column's left edge, as the most common starting x.
  const lefts = lines.map((l) => Math.round(l.x)).sort((a, b) => a - b);
  const leftEdge = lefts[Math.floor(lefts.length * 0.25)] ?? 0;

  const paragraphs: string[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length > 0) paragraphs.push(text);
    buffer = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const previous = lines[i - 1];

    if (previous) {
      const gap = Math.abs(previous.y - line.y);
      const indented = line.x > leftEdge + Math.max(6, line.height * 0.6);
      const bigGap = gap > medianStep * 1.45;
      // A short previous line that is well clear of the right margin also ends
      // a paragraph, but only in combination with one of the above.
      if (bigGap || indented) flush();
    }

    // A line that already looks like a heading or a list item stands alone.
    if (/^(?:\d{1,2}(?:\.\d{1,2})*\s+\S|[A-Z][A-Z \d.]{4,}$)/.test(line.text) && line.text.length < 90) {
      flush();
      paragraphs.push(line.text);
      continue;
    }

    // Rejoin a word split by a hyphen at the line break.
    const last = buffer[buffer.length - 1];
    if (last !== undefined && /[\p{L}]-$/u.test(last)) {
      buffer[buffer.length - 1] = last.slice(0, -1) + line.text;
    } else {
      buffer.push(line.text);
    }
  }
  flush();
  return paragraphs;
}

/** Join paragraphs, merging a page break that falls mid-sentence. */
function joinParagraphs(paragraphs: readonly string[]): string {
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    const previous = out[out.length - 1];
    // A paragraph that neither ended nor started a sentence is a page break in
    // the middle of one; stitch the two halves back together.
    if (
      previous !== undefined &&
      !/[.!?:;"'”’)\]]$/.test(previous) &&
      /^[\p{Ll}]/u.test(paragraph)
    ) {
      out[out.length - 1] = `${previous} ${paragraph}`;
      continue;
    }
    out.push(paragraph);
  }
  return out.join('\n\n').trim();
}

function cleanMeta(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return undefined;
  // PDF producers routinely leave the source filename in the Title field.
  if (/\.(?:pdf|docx?|tex|indd)$/i.test(text)) return undefined;
  if (/^(?:untitled|microsoft word|document\d*)$/i.test(text)) return undefined;
  return text;
}
