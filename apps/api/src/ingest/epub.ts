import { listEntries, readEntry, readTextEntry, type ZipEntry } from './zip.js';
import { decodeEntities, markupToText, normaliseWhitespace } from './xml.js';
import type { Extracted } from './types.js';

/**
 * EPUB text extraction.
 *
 * An .epub is a zip containing XHTML documents plus an OPF package file that
 * lists them in reading order. Following the spine matters: the zip's own entry
 * order has nothing to do with the order the chapters are meant to be read in,
 * and an alphabetical pass produces chapter 10 before chapter 2.
 */
export function extractEpub(buf: Buffer): Extracted {
  const entries = listEntries(buf);

  const opfPath = findOpfPath(buf, entries);
  if (!opfPath) throw new Error('not an EPUB: no package document found');
  const opf = readTextEntry(buf, entries, opfPath);
  if (opf === null) throw new Error(`EPUB package document ${opfPath} could not be read`);

  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  // id -> href, from the manifest.
  const manifest = new Map<string, string>();
  const itemRe = /<item\b([^>]*)\/?>/gi;
  let item: RegExpExecArray | null;
  while ((item = itemRe.exec(opf)) !== null) {
    const attrs = item[1]!;
    const id = attr(attrs, 'id');
    const href = attr(attrs, 'href');
    const mediaType = attr(attrs, 'media-type') ?? '';
    if (id && href && /xhtml|html/i.test(mediaType)) manifest.set(id, href);
  }

  // Reading order, from the spine.
  const spine: string[] = [];
  const spineBlock = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(opf)?.[1] ?? '';
  const refRe = /<itemref\b([^>]*)\/?>/gi;
  let ref: RegExpExecArray | null;
  while ((ref = refRe.exec(spineBlock)) !== null) {
    const idref = attr(ref[1]!, 'idref');
    const href = idref ? manifest.get(idref) : undefined;
    if (href) spine.push(href);
  }
  // Some malformed files have no usable spine; fall back to manifest order.
  const order = spine.length > 0 ? spine : [...manifest.values()];

  const parts: string[] = [];
  for (const href of order) {
    const resolved = resolvePath(base, decodeURIComponent(href.split('#')[0]!));
    const entry = entries.find((e) => e.name === resolved);
    if (!entry) continue;
    const html = readEntry(buf, entry).toString('utf8');
    const text = markupToText(html);
    if (text.trim().length > 0) parts.push(text);
  }

  if (parts.length === 0) throw new Error('EPUB contained no readable text');
  return {
    text: normaliseWhitespace(parts.join('\n\n')),
    title: opfMeta(opf, 'dc:title') ?? undefined,
    author: opfMeta(opf, 'dc:creator') ?? undefined,
  };
}

/** container.xml points at the package document; fall back to a scan if absent. */
function findOpfPath(buf: Buffer, entries: readonly ZipEntry[]): string | null {
  const container = readTextEntry(buf, entries, 'META-INF/container.xml');
  if (container) {
    const full = /<rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i.exec(container)?.[1];
    if (full) return full;
  }
  return entries.find((e) => e.name.toLowerCase().endsWith('.opf'))?.name ?? null;
}

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs)?.[1];
}

function opfMeta(opf: string, tag: string): string | null {
  const raw = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(opf)?.[1];
  const text = raw ? decodeEntities(raw.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
  return text.length > 0 ? text : null;
}

/** Resolve an href against the package document's directory, collapsing `..`. */
function resolvePath(base: string, href: string): string {
  if (href.startsWith('/')) return href.slice(1);
  const segments = (base + href).split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}
