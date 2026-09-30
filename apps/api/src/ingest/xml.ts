/**
 * Small XML/HTML helpers shared by the DOCX, EPUB and HTML extractors.
 *
 * These formats are all "structured text with tags around it"; what the reader
 * needs out of them is paragraph boundaries and the text between them, not a
 * DOM. Working on the markup directly keeps ingestion dependency-free and is
 * resilient to the malformed markup real documents are full of.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
  bull: '•', middot: '·', deg: '°', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è',
  agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', shy: '',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Remove a whole element including its contents, e.g. `<script>...</script>`. */
export function stripElement(html: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
  let previous: string;
  let current = html;
  // Repeat because removing one element can reveal a nested pair.
  do {
    previous = current;
    current = current.replace(re, ' ');
  } while (current !== previous);
  return current.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ');
}

/**
 * Convert markup to plain text, turning block-level tags into blank lines so
 * the downstream block splitter sees paragraph boundaries.
 */
export function markupToText(markup: string): string {
  let text = markup;
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = stripElement(text, 'script');
  text = stripElement(text, 'style');
  text = stripElement(text, 'noscript');
  text = stripElement(text, 'svg');
  text = stripElement(text, 'head');

  // Preserve headings and list items as their own blocks with their markers,
  // so the block classifier can recognise them.
  text = text.replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${'#'.repeat(Number(level))} `);
  text = text.replace(/<\/h[1-6]\s*>/gi, '\n\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n\n- ');
  text = text.replace(/<\/li\s*>/gi, '\n');
  text = text.replace(/<blockquote\b[^>]*>/gi, '\n\n> ');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  const blockTags = 'p|div|section|article|header|footer|main|aside|figure|figcaption|table|tr|ul|ol|dl|dt|dd|pre|hr|nav';
  text = text.replace(new RegExp(`</?(?:${blockTags})\\b[^>]*>`, 'gi'), '\n\n');

  // Everything left is inline markup.
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);

  return normaliseWhitespace(text);
}

/** Collapse runs of spaces and of blank lines without losing paragraph breaks. */
export function normaliseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extract the text content of the first matching element, if any. */
export function firstTagText(markup: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i');
  const m = re.exec(markup);
  if (!m?.[1]) return null;
  const text = decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
}

/** Read an attribute off the first element matching `selectorAttr="value"`. */
export function metaContent(html: string, patterns: readonly RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) {
      const text = decodeEntities(m[1]).trim();
      if (text.length > 0) return text;
    }
  }
  return null;
}
