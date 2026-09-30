import { listEntries, readEntry, readTextEntry } from './zip.js';
import { decodeEntities, normaliseWhitespace } from './xml.js';
import type { Extracted } from './types.js';

/**
 * DOCX text extraction.
 *
 * A .docx is a zip whose word/document.xml holds the body. Text lives in <w:t>
 * runs inside <w:p> paragraphs; everything else -- styling, revision marks,
 * comments -- is skipped. Paragraph style names are used to recognise headings,
 * which is how the reader gets an outline.
 */
export function extractDocx(buf: Buffer): Extracted {
  const entries = listEntries(buf);
  const documentXml = readTextEntry(buf, entries, 'word/document.xml');
  if (documentXml === null) throw new Error('not a Word document: word/document.xml is missing');

  const paragraphs: string[] = [];
  const paragraphRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let match: RegExpExecArray | null;

  while ((match = paragraphRe.exec(documentXml)) !== null) {
    const body = match[1]!;

    // Concatenate the text runs, honouring explicit tabs and line breaks.
    let text = '';
    const partRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g;
    let part: RegExpExecArray | null;
    while ((part = partRe.exec(body)) !== null) {
      if (part[1] !== undefined) text += decodeEntities(part[1]);
      else if (part[0].startsWith('<w:tab')) text += ' ';
      else text += '\n';
    }

    text = text.replace(/[ \t]+/g, ' ').trim();
    if (text.length === 0) {
      paragraphs.push('');
      continue;
    }

    // Word's built-in heading styles are named Heading1..Heading9 / heading 1.
    const style = /<w:pStyle\s+w:val="([^"]+)"/i.exec(body)?.[1] ?? '';
    const headingLevel = /^heading\s*([1-9])$/i.exec(style.replace(/\s+/g, ' ').trim())?.[1];
    const isListItem = /<w:numPr\b/.test(body);

    if (headingLevel) paragraphs.push(`${'#'.repeat(Math.min(3, Number(headingLevel)))} ${text}`);
    else if (isListItem) paragraphs.push(`- ${text}`);
    else if (/^title$/i.test(style)) paragraphs.push(`# ${text}`);
    else paragraphs.push(text);
  }

  const text = normaliseWhitespace(paragraphs.join('\n\n'));
  return { text, title: titleFromDocx(buf, entries) ?? undefined };
}

function titleFromDocx(buf: Buffer, entries: ReturnType<typeof listEntries>): string | null {
  const core = entries.find((e) => e.name === 'docProps/core.xml');
  if (!core) return null;
  const xml = readEntry(buf, core).toString('utf8');
  const title = /<dc:title>([\s\S]*?)<\/dc:title>/i.exec(xml)?.[1];
  const clean = title ? decodeEntities(title).trim() : '';
  return clean.length > 0 ? clean : null;
}
