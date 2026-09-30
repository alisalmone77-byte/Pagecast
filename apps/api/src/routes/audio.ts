import { progressAt, type ReadingPosition, type Timeline } from '@pagecast/core';
import { HttpError, readJson, sendJson, type Router } from '../http.js';
import { store } from '../store.js';
import { findVoice, getProgress, listVoices, synthesizeDocument } from '../tts/index.js';
import { hub } from '../ws.js';
import { timeAtPosition } from '@pagecast/core';

/** Voice catalogue, synthesis control, timelines and audio delivery. */
export function registerAudioRoutes(router: Router): void {
  router.get('/api/voices', (ctx) => {
    sendJson(ctx.res, 200, { voices: listVoices() });
  });

  /**
   * Start (or join) synthesis. Returns as soon as the first chunk is ready so
   * the client can begin playing; the rest streams in behind it.
   */
  router.post('/api/documents/:id/audio', async (ctx) => {
    const id = requireId(ctx.params['id']);
    const doc = await store.getDocument(id);
    const body = await readJson<{ voiceId?: string; wait?: boolean }>(ctx.req).catch(() => ({} as { voiceId?: string; wait?: boolean }));
    const voice = findVoice(body.voiceId);

    const existing = await store.getTimeline(id, voice.id);
    if (existing && doc.meta.audioState === 'ready') {
      sendJson(ctx.res, 200, { timeline: existing, state: 'ready' });
      return;
    }

    const task = synthesizeDocument(id, doc.content, voice, (p) => {
      hub.broadcastSynthesis(ctx.userId, p.documentId, p.voiceId, p.done, p.total);
    });
    // Surface the failure in the log; the HTTP response below reports status.
    task.catch((err: unknown) => {
      console.error(`[tts] synthesis failed for ${id}:`, err instanceof Error ? err.message : err);
    });

    if (body.wait) {
      sendJson(ctx.res, 200, { timeline: await task, state: 'ready' });
      return;
    }

    // Wait only for enough of the timeline to start playback, not all of it.
    const timeline = await firstPlayableTimeline(id, voice.id);
    sendJson(ctx.res, 202, {
      timeline,
      state: timeline && timeline.chunks.length > 0 ? 'partial' : 'pending',
      progress: getProgress(id, voice.id),
    });
  });

  /** Poll synthesis progress and fetch the timeline as it grows. */
  router.get('/api/documents/:id/timeline', async (ctx) => {
    const id = requireId(ctx.params['id']);
    const voice = findVoice(ctx.query.get('voiceId') ?? undefined);
    const timeline = await store.getTimeline(id, voice.id);
    const progress = getProgress(id, voice.id);

    sendJson(ctx.res, 200, {
      timeline,
      voiceId: voice.id,
      done: progress?.done ?? (timeline ? timeline.chunks.length : 0),
      total: progress?.total ?? (timeline ? timeline.chunks.length : 0),
      error: progress?.error ?? null,
    });
  });

  /** Which voices already have a timeline, so the picker can show what is cached. */
  router.get('/api/documents/:id/voices', async (ctx) => {
    const id = requireId(ctx.params['id']);
    sendJson(ctx.res, 200, { synthesized: await store.listTimelineVoices(id) });
  });

  /** Media time for a position: how the client turns a resume point into a seek. */
  router.post('/api/documents/:id/seek', async (ctx) => {
    const id = requireId(ctx.params['id']);
    const body = await readJson<{ position: ReadingPosition; voiceId?: string }>(ctx.req);
    const voice = findVoice(body.voiceId);
    const timeline = await store.getTimeline(id, voice.id);
    if (!timeline) throw new HttpError(409, `document ${id} has no audio for voice ${voice.id} yet`);

    const doc = await store.getDocument(id);
    sendJson(ctx.res, 200, {
      timeMs: timeAtPosition(timeline, body.position),
      progress: progressAt(doc.content, body.position),
    });
  });

  /**
   * Serve a synthesised chunk.
   *
   * Range requests are honoured because both `<audio>` and AVPlayer issue them
   * for seeking, and a server that ignores Range makes a scrub re-download the
   * whole file.
   */
  router.get('/api/documents/:id/audio/:voiceId/:file', async (ctx) => {
    const id = requireId(ctx.params['id']);
    const voiceId = requireId(ctx.params['voiceId']);
    const file = requireId(ctx.params['file']);

    const parsed = /^(\d+)\.([a-z0-9]+)$/i.exec(file);
    if (!parsed) throw new HttpError(400, `malformed audio filename: ${file}`);
    const index = Number(parsed[1]);
    const ext = parsed[2]!.toLowerCase();

    const bytes = await store.readAudioChunk(id, voiceId, index, ext);
    if (!bytes) throw new HttpError(404, `chunk ${index} of ${id} has not been synthesised`);

    const mimeType = ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : 'application/octet-stream';
    const range = ctx.req.headers['range'];

    if (typeof range === 'string') {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        const total = bytes.length;
        const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2] || 0));
        const end = m[2] && m[1] ? Math.min(total - 1, Number(m[2])) : total - 1;

        if (!Number.isFinite(start) || start >= total || start > end) {
          ctx.res.writeHead(416, { 'content-range': `bytes */${total}` });
          ctx.res.end();
          return;
        }
        const slice = bytes.subarray(start, end + 1);
        ctx.res.writeHead(206, {
          'content-type': mimeType,
          'content-length': slice.length,
          'content-range': `bytes ${start}-${end}/${total}`,
          'accept-ranges': 'bytes',
          // Chunks are immutable once written: cache them hard for offline use.
          'cache-control': 'public, max-age=31536000, immutable',
        });
        ctx.res.end(slice);
        return;
      }
    }

    ctx.res.writeHead(200, {
      'content-type': mimeType,
      'content-length': bytes.length,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    ctx.res.end(bytes);
  });
}

/**
 * Resolve once at least one chunk exists, so a caller can start playing while
 * the rest of a long document is still rendering. Gives up after a short wait
 * and lets the client poll instead of holding the request open.
 */
async function firstPlayableTimeline(
  documentId: string, voiceId: string, timeoutMs = 25_000,
): Promise<Timeline | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const timeline = await store.getTimeline(documentId, voiceId);
    if (timeline && timeline.chunks.length > 0) return timeline;
    const progress = getProgress(documentId, voiceId);
    if (progress?.error) throw new HttpError(502, `synthesis failed: ${progress.error}`);
    if (Date.now() >= deadline) return timeline;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function requireId(value: string | undefined): string {
  if (!value) throw new HttpError(400, 'a path parameter is missing');
  return value;
}
