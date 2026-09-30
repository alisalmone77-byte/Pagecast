import { clampPosition, progressAt, type ReadingPosition, type ReadingState } from '@pagecast/core';
import { HttpError, readJson, sendJson, type Router } from '../http.js';
import { store } from '../store.js';
import { hub } from '../ws.js';
import { findVoice } from '../tts/index.js';

/**
 * Cross-device reading state.
 *
 * REST is the source of truth; the WebSocket only pushes what a write already
 * committed. A client that cannot hold a socket open still syncs correctly --
 * it just learns about the other device's progress on its next read rather
 * than immediately.
 */
export function registerSyncRoutes(router: Router): void {
  /** Everything this user has state for, for a cold start on a new device. */
  router.get('/api/sync/state', async (ctx) => {
    sendJson(ctx.res, 200, { states: await store.listStates(ctx.userId) });
  });

  router.get('/api/sync/state/:documentId', async (ctx) => {
    const documentId = requireId(ctx.params['documentId']);
    await store.getDocument(documentId, ctx.userId);
    const state = await store.getState(ctx.userId, documentId);
    if (!state) throw new HttpError(404, `no reading state for ${documentId}`);
    sendJson(ctx.res, 200, { state });
  });

  /**
   * Record progress. The client sends the revision it believed it was building
   * on; the store merges and returns the authoritative result, which may not be
   * what was sent if another device got there first.
   */
  router.put('/api/sync/state/:documentId', async (ctx) => {
    const documentId = requireId(ctx.params['documentId']);
    const doc = await store.getDocument(documentId, ctx.userId);
    const body = await readJson<{
      position?: ReadingPosition;
      speed?: number;
      voiceId?: string;
      rev?: number;
      deviceId?: string;
    }>(ctx.req);

    const position = clampPosition(doc.content, body.position ?? { blockIndex: 0, tokenIndex: 0 });
    const voice = findVoice(body.voiceId);

    const incoming: ReadingState = {
      documentId,
      position,
      progress: progressAt(doc.content, position),
      speed: clampSpeed(body.speed),
      voiceId: voice.id,
      rev: Number.isFinite(body.rev) ? Number(body.rev) : 0,
      updatedAt: new Date().toISOString(),
      deviceId: body.deviceId ?? ctx.deviceId,
    };

    const { state, changed } = await store.applyState(ctx.userId, incoming);
    if (changed) hub.broadcastState(ctx.userId, state, incoming.deviceId);

    sendJson(ctx.res, 200, {
      state,
      // False means another device was ahead and this write did not land as sent.
      accepted: state.deviceId === incoming.deviceId && changed,
    });
  });

  router.delete('/api/sync/state/:documentId', async (ctx) => {
    const documentId = requireId(ctx.params['documentId']);
    const doc = await store.getDocument(documentId, ctx.userId);
    const reset: ReadingState = {
      documentId,
      position: { blockIndex: 0, tokenIndex: 0 },
      progress: 0,
      speed: 1,
      voiceId: findVoice(undefined).id,
      rev: (await store.getState(ctx.userId, documentId))?.rev ?? 0,
      updatedAt: new Date().toISOString(),
      deviceId: ctx.deviceId,
    };
    void doc;
    const { state } = await store.applyState(ctx.userId, reset);
    hub.broadcastState(ctx.userId, state, ctx.deviceId);
    sendJson(ctx.res, 200, { state });
  });
}

/** The spec's range, clamped and rounded to the 0.1x steps the UI offers. */
function clampSpeed(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.min(4.5, Math.max(0.5, n)) * 10) / 10;
}

function requireId(value: string | undefined): string {
  if (!value) throw new HttpError(400, 'a document id is required');
  return value;
}
