import { HttpError, readBody, readJson, sendJson, type Router } from '../http.js';
import { detectKind, ingest } from '../ingest/index.js';
import type { SourceKind } from '@pagecast/core';

/**
 * Ingestion endpoints.
 *
 * Two shapes, because the two callers want different things: browsers and the
 * iOS file picker POST raw bytes (no multipart parsing, no base64 inflation),
 * while the URL scraper and the OCR scanner POST JSON.
 */
export function registerIngestRoutes(router: Router): void {
  /**
   * Raw file upload. The body is the file; the filename rides in a header.
   * The format is sniffed from the leading bytes, so a mislabelled extension
   * still lands in the right extractor.
   */
  router.post('/api/ingest/file', async (ctx) => {
    const bytes = await readBody(ctx.req);
    if (bytes.length === 0) throw new HttpError(400, 'the request body was empty');

    const filename = header(ctx.req.headers['x-pagecast-filename']);
    const title = header(ctx.req.headers['x-pagecast-title']);
    const kind = detectKind(bytes, filename);

    const doc = await ingest({ kind, bytes, filename, title });
    sendJson(ctx.res, 201, { meta: doc.meta });
  });

  /** Scrape an article from a URL. */
  router.post('/api/ingest/url', async (ctx) => {
    const body = await readJson<{ url?: string; title?: string }>(ctx.req);
    if (!body.url || body.url.trim().length === 0) throw new HttpError(400, 'a url is required');
    const doc = await ingest({ kind: 'url', url: body.url.trim(), title: body.title });
    sendJson(ctx.res, 201, { meta: doc.meta });
  });

  /**
   * Text straight from the client: a paste, or OCR output from the iOS
   * scanner. The scanner sends one string per page; they are joined with blank
   * lines so page breaks become paragraph breaks.
   */
  router.post('/api/ingest/text', async (ctx) => {
    const body = await readJson<{ text?: string; pages?: string[]; title?: string; kind?: SourceKind }>(ctx.req);
    const text = body.pages?.length ? body.pages.join('\n\n') : body.text;
    if (!text || text.trim().length === 0) throw new HttpError(400, 'text or pages is required');

    const kind: SourceKind = body.kind === 'scan' ? 'scan' : 'paste';
    const doc = await ingest({ kind, text, title: body.title });
    sendJson(ctx.res, 201, { meta: doc.meta });
  });
}

function header(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  // Filenames arrive percent-encoded so non-ASCII names survive the header.
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
