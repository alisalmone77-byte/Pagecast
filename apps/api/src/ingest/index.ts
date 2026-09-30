import { buildContent, blocksFromText, totalWords, type DocumentMeta, type SourceKind } from '@pagecast/core';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { store, type StoredDocument } from '../store.js';
import { extractDocx } from './docx.js';
import { extractEpub } from './epub.js';
import { extractHtml } from './html.js';
import { extractPdf } from './pdf.js';
import { normaliseWhitespace } from './xml.js';
import type { Extracted, IngestRequest } from './types.js';

export type { Extracted, IngestRequest } from './types.js';

/** Sniff the format from the leading bytes rather than trusting the extension. */
export function detectKind(bytes: Buffer, filename?: string): SourceKind {
  if (bytes.length >= 4) {
    if (bytes.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      // A zip: EPUB declares its media type in the first entry, DOCX does not.
      const head = bytes.subarray(0, 4096).toString('latin1');
      if (head.includes('mimetypeapplication/epub+zip') || head.includes('epub+zip')) return 'epub';
      if (head.includes('word/') || head.includes('[Content_Types].xml')) return 'docx';
      return 'docx';
    }
  }
  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case 'pdf': return 'pdf';
    case 'epub': return 'epub';
    case 'docx': return 'docx';
    case 'htm':
    case 'html': return 'url';
    default: return 'txt';
  }
}

/** Run the right extractor for a request. */
export async function extract(request: IngestRequest): Promise<Extracted> {
  switch (request.kind) {
    case 'pdf': {
      requireBytes(request);
      return extractPdf(request.bytes!);
    }
    case 'epub': {
      requireBytes(request);
      return extractEpub(request.bytes!);
    }
    case 'docx': {
      requireBytes(request);
      return extractDocx(request.bytes!);
    }
    case 'url': {
      if (request.bytes) return extractHtml(request.bytes.toString('utf8'), request.url);
      if (!request.url) throw new HttpError(400, 'a url is required');
      return fetchAndExtract(request.url);
    }
    case 'txt':
    case 'paste':
    case 'scan': {
      const text = request.text ?? request.bytes?.toString('utf8') ?? '';
      if (text.trim().length === 0) throw new HttpError(400, 'no text supplied');
      return { text: normaliseWhitespace(text) };
    }
    default:
      throw new HttpError(400, `unsupported source kind: ${String(request.kind)}`);
  }
}

function requireBytes(request: IngestRequest): void {
  if (!request.bytes || request.bytes.length === 0) {
    throw new HttpError(400, `a file body is required for ${request.kind}`);
  }
}

/**
 * Fetch a page and extract its article text.
 *
 * Only http(s) is followed, and the response is capped, so a malicious or
 * broken URL cannot be used to make the server stream an unbounded body.
 */
async function fetchAndExtract(rawUrl: string): Promise<Extracted> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, `not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, `unsupported protocol ${url.protocol}`);
  }

  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      // Identify honestly; some sites serve a different page to unknown agents.
      'user-agent': 'Pagecast/0.1 (+https://github.com/alisalmone77-byte/Pagecast)',
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
    },
    signal: AbortSignal.timeout(20_000),
  }).catch((err: unknown) => {
    throw new HttpError(502, `could not fetch ${url.href}: ${err instanceof Error ? err.message : String(err)}`);
  });

  if (!response.ok) throw new HttpError(502, `${url.href} returned ${response.status}`);

  const contentType = response.headers.get('content-type') ?? '';
  const buffer = await readCapped(response, config.maxFetchBytes);

  if (contentType.includes('application/pdf')) return extractPdf(buffer);
  if (contentType.includes('epub')) return extractEpub(buffer);
  if (contentType.startsWith('text/plain')) {
    return { text: normaliseWhitespace(buffer.toString('utf8')) };
  }
  return extractHtml(buffer.toString('utf8'), url.href);
}

async function readCapped(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, `remote document is ${declared} bytes, over the ${limit} byte limit`);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.arrayBuffer());

  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HttpError(413, `remote document exceeds the ${limit} byte limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Derive a title when neither the format nor the caller supplied one. */
export function deriveTitle(extracted: Extracted, request: IngestRequest): string {
  const explicit = request.title?.trim();
  if (explicit) return explicit;
  if (extracted.title) return extracted.title.slice(0, 200);

  if (request.filename) {
    const base = request.filename.replace(/\.[a-z0-9]{1,6}$/i, '').replace(/[-_]+/g, ' ').trim();
    if (base.length > 0) return base.slice(0, 200);
  }
  if (request.url) {
    try { return new URL(request.url).hostname; } catch { /* fall through */ }
  }
  // Last resort: the first line of the document itself.
  const firstLine = extracted.text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return firstLine.length > 0 ? firstLine.slice(0, 80) : 'Untitled document';
}

/** Extract, parse and persist a new document. */
export async function ingest(request: IngestRequest): Promise<StoredDocument> {
  const extracted = await extract(request);
  const text = extracted.text.trim();
  if (text.length === 0) {
    throw new HttpError(422, 'no readable text could be extracted from this source');
  }

  const content = buildContent(blocksFromText(text));
  if (content.blocks.length === 0) {
    throw new HttpError(422, 'the extracted text contained no readable paragraphs');
  }

  const now = new Date().toISOString();
  const meta: DocumentMeta = {
    id: store.newDocumentId(),
    ownerId: request.ownerId,
    title: deriveTitle(extracted, request),
    author: extracted.author,
    sourceKind: request.kind,
    sourceRef: request.url ?? request.filename,
    createdAt: now,
    updatedAt: now,
    wordCount: totalWords(content),
    blockCount: content.blocks.length,
    audioState: 'none',
    folderId: null,
    bookmarked: false,
  };

  return store.saveDocument({ meta, content, rawText: text });
}
