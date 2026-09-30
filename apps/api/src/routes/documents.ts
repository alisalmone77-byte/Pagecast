import {
  clampPosition, progressAt, resumeTarget, sentenceAtPosition, totalWords,
  type DocumentMeta, type Highlight, type ReadingPosition,
} from '@pagecast/core';
import { HttpError, readJson, sendJson, type Router } from '../http.js';
import { store } from '../store.js';
import { defaultVoice } from '../tts/index.js';
import { randomUUID } from 'node:crypto';

/** Library listing, document content, metadata edits and annotations. */
export function registerDocumentRoutes(router: Router): void {
  /** The library view: metadata plus each document's reading state. */
  router.get('/api/documents', async (ctx) => {
    const states = new Map((await store.listStates(ctx.userId)).map((s) => [s.documentId, s]));
    const documents = store.listDocuments(ctx.userId).map((meta) => ({
      ...meta,
      state: states.get(meta.id) ?? null,
    }));
    sendJson(ctx.res, 200, { documents });
  });

  /**
   * "Continue listening": the documents with progress, most recently touched
   * first, excluding anything already finished.
   */
  router.get('/api/documents/continue', async (ctx) => {
    const limit = Math.min(20, Math.max(1, Number(ctx.query.get('limit') ?? '5')));
    const states = (await store.listStates(ctx.userId))
      .filter((s) => s.progress > 0.005 && s.progress < 0.995)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);

    const documents = states
      .map((state) => {
        const meta = store.getMeta(state.documentId);
        // Reading state is already per-user, but check ownership anyway so a
        // document deleted and its id reused can never leak across accounts.
        return meta && meta.ownerId === ctx.userId ? { ...meta, state } : null;
      })
      .filter((d): d is DocumentMeta & { state: typeof states[number] } => d !== null);

    sendJson(ctx.res, 200, { documents });
  });

  /** Full document: metadata, blocks, sentences and the reader's state. */
  router.get('/api/documents/:id', async (ctx) => {
    const doc = await store.getDocument(requireId(ctx.params['id']), ctx.userId);
    const state = await store.ensureState(ctx.userId, doc.meta.id, defaultVoice().id);
    sendJson(ctx.res, 200, {
      meta: doc.meta,
      content: doc.content,
      state,
      highlights: await store.listHighlights(ctx.userId, doc.meta.id),
    });
  });

  /** Metadata edits: rename, bookmark, move between folders. */
  router.patch('/api/documents/:id', async (ctx) => {
    const id = requireId(ctx.params['id']);
    const body = await readJson<Partial<Pick<DocumentMeta, 'title' | 'author' | 'folderId' | 'bookmarked'>>>(ctx.req);

    const patch: { -readonly [K in keyof DocumentMeta]?: DocumentMeta[K] } = {};
    if (typeof body.title === 'string') {
      const title = body.title.trim();
      if (title.length === 0) throw new HttpError(400, 'title cannot be empty');
      patch.title = title.slice(0, 200);
    }
    if (typeof body.author === 'string') patch.author = body.author.trim().slice(0, 200);
    if (body.folderId === null || typeof body.folderId === 'string') patch.folderId = body.folderId;
    if (typeof body.bookmarked === 'boolean') patch.bookmarked = body.bookmarked;

    sendJson(ctx.res, 200, { meta: await store.updateMeta(id, patch, ctx.userId) });
  });

  router.delete('/api/documents/:id', async (ctx) => {
    const id = requireId(ctx.params['id']);
    await store.deleteDocument(id, ctx.userId);
    sendJson(ctx.res, 200, { deleted: id });
  });

  /**
   * Resolve a position to everything the client needs to jump there: the
   * sentence it belongs to, the sentence-aligned resume point, and progress.
   */
  router.post('/api/documents/:id/resolve', async (ctx) => {
    const doc = await store.getDocument(requireId(ctx.params['id']), ctx.userId);
    const body = await readJson<{ position: ReadingPosition }>(ctx.req);
    const position = clampPosition(doc.content, body.position ?? { blockIndex: 0, tokenIndex: 0 });

    sendJson(ctx.res, 200, {
      position,
      resumeAt: resumeTarget(doc.content, position),
      sentenceIndex: sentenceAtPosition(doc.content, position),
      progress: progressAt(doc.content, position),
      wordCount: totalWords(doc.content),
    });
  });

  /* ------------------------------------------------------------ highlights */

  router.get('/api/documents/:id/highlights', async (ctx) => {
    const id = requireId(ctx.params['id']);
    await store.getDocument(id, ctx.userId);
    sendJson(ctx.res, 200, { highlights: await store.listHighlights(ctx.userId, id) });
  });

  router.post('/api/documents/:id/highlights', async (ctx) => {
    const id = requireId(ctx.params['id']);
    const doc = await store.getDocument(id, ctx.userId);
    const body = await readJson<Omit<Highlight, 'id' | 'documentId' | 'createdAt'>>(ctx.req);

    const block = doc.content.blocks[body.blockIndex];
    if (!block) throw new HttpError(400, `block ${body.blockIndex} is outside this document`);
    const startToken = Math.max(0, Math.min(block.tokens.length - 1, body.startToken ?? 0));
    const endToken = Math.max(startToken + 1, Math.min(block.tokens.length, body.endToken ?? startToken + 1));

    const highlight: Highlight = {
      id: randomUUID(),
      documentId: id,
      blockIndex: body.blockIndex,
      startToken,
      endToken,
      note: typeof body.note === 'string' ? body.note.slice(0, 4000) : undefined,
      color: typeof body.color === 'string' ? body.color.slice(0, 32) : undefined,
      createdAt: new Date().toISOString(),
    };

    const all = await store.listHighlights(ctx.userId, id);
    all.push(highlight);
    await store.saveHighlights(ctx.userId, id, all);
    sendJson(ctx.res, 201, { highlight });
  });

  router.delete('/api/documents/:id/highlights/:highlightId', async (ctx) => {
    const id = requireId(ctx.params['id']);
    const highlightId = requireId(ctx.params['highlightId']);
    await store.getDocument(id, ctx.userId);
    const all = await store.listHighlights(ctx.userId, id);
    const remaining = all.filter((h) => h.id !== highlightId);
    if (remaining.length === all.length) throw new HttpError(404, `no highlight ${highlightId}`);
    await store.saveHighlights(ctx.userId, id, remaining);
    sendJson(ctx.res, 200, { deleted: highlightId });
  });
}

function requireId(value: string | undefined): string {
  if (!value) throw new HttpError(400, 'a document id is required');
  return value;
}
