import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The store reads its directory at import time, so point it somewhere
// disposable before anything under dist/ is loaded.
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pagecast-test-'));
process.env.PAGECAST_DATA_DIR = dataDir;
process.env.PAGECAST_TTS_PROVIDER = 'local';

const { createServer } = await import('../dist/server.js');
const { store } = await import('../dist/store.js');
const { startServer } = await import('./helpers.js');

let base;
let stop;

before(async () => {
  await store.init();
  ({ base, stop } = await startServer(createServer));
});

after(async () => {
  await stop?.();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const SAMPLE = [
  '# Deep Work',
  '',
  'The ability to concentrate is becoming rare. It is also becoming valuable.',
  '',
  'Those two trends together produce an opportunity. Cultivating focus is the work.',
].join('\n');

async function api(method, route, body, headers = {}) {
  const init = { method, headers: { 'x-pagecast-device': 'test-device', ...headers } };
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
  }
  const res = await fetch(`${base}${route}`, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function ingestSample(title = 'Deep Work') {
  const res = await api('POST', '/api/ingest/text', { text: SAMPLE, title });
  assert.equal(res.status, 201, res.text);
  return res.json.meta;
}

test('health reports the configured provider', async () => {
  const res = await api('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.ttsProvider, 'local');
});

test('an unknown api route is a 404 with a message', async () => {
  const res = await api('GET', '/api/nope');
  assert.equal(res.status, 404);
  assert.match(res.json.error, /no route/);
});

test('the wrong method on a real route is a 405', async () => {
  const res = await api('DELETE', '/api/health');
  assert.equal(res.status, 405);
});

test('text ingestion parses into blocks and sentences', async () => {
  const meta = await ingestSample('Ingestion Test');
  assert.equal(meta.title, 'Ingestion Test');
  assert.equal(meta.sourceKind, 'paste');
  assert.ok(meta.wordCount > 15);

  const res = await api('GET', `/api/documents/${meta.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.content.blocks[0].type, 'heading1');
  assert.ok(res.json.content.sentences.length >= 4);
});

test('scanner pages are joined as separate paragraphs', async () => {
  const res = await api('POST', '/api/ingest/text', {
    pages: ['Page one text here.', 'Page two text here.'],
    kind: 'scan',
    title: 'Scanned',
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.meta.sourceKind, 'scan');
  const doc = await api('GET', `/api/documents/${res.json.meta.id}`);
  assert.equal(doc.json.content.blocks.length, 2);
});

test('empty ingestion is rejected rather than stored', async () => {
  assert.equal((await api('POST', '/api/ingest/text', { text: '   ' })).status, 400);
  assert.equal((await api('POST', '/api/ingest/file', Buffer.alloc(0))).status, 400);
  assert.equal((await api('POST', '/api/ingest/url', { url: 'not a url' })).status, 400);
  assert.equal((await api('POST', '/api/ingest/url', { url: 'ftp://x/y' })).status, 400);
});

test('a file upload is routed by its magic bytes', async () => {
  const res = await api('POST', '/api/ingest/file', Buffer.from('Just some plain text content here.'), {
    'x-pagecast-filename': 'notes.txt',
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.meta.sourceKind, 'txt');
  assert.equal(res.json.meta.title, 'notes');
});

test('the library lists documents with their reading state', async () => {
  await ingestSample('Library Entry');
  const res = await api('GET', '/api/documents');
  assert.equal(res.status, 200);
  assert.ok(res.json.documents.some((d) => d.title === 'Library Entry'));
  assert.ok('state' in res.json.documents[0]);
});

test('metadata can be renamed and bookmarked, and an empty title refused', async () => {
  const meta = await ingestSample('Before');
  const renamed = await api('PATCH', `/api/documents/${meta.id}`, { title: 'After', bookmarked: true });
  assert.equal(renamed.json.meta.title, 'After');
  assert.equal(renamed.json.meta.bookmarked, true);
  assert.equal((await api('PATCH', `/api/documents/${meta.id}`, { title: '  ' })).status, 400);
});

test('a document can be deleted and is then gone', async () => {
  const meta = await ingestSample('Temporary');
  assert.equal((await api('DELETE', `/api/documents/${meta.id}`)).status, 200);
  assert.equal((await api('GET', `/api/documents/${meta.id}`)).status, 404);
  assert.equal((await api('DELETE', `/api/documents/${meta.id}`)).status, 404);
});

test('resolve returns the sentence-aligned resume point', async () => {
  const meta = await ingestSample();
  const res = await api('POST', `/api/documents/${meta.id}/resolve`, {
    position: { blockIndex: 1, tokenIndex: 5 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.resumeAt.blockIndex, 1);
  assert.equal(res.json.resumeAt.tokenIndex, 0);
  assert.ok(res.json.progress > 0);
});

test('an out-of-range position is clamped, not an error', async () => {
  const meta = await ingestSample();
  const res = await api('POST', `/api/documents/${meta.id}/resolve`, {
    position: { blockIndex: 9999, tokenIndex: 9999 },
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.position.blockIndex < 10);
});

test('synthesis produces a playable timeline and serves the audio', async () => {
  const meta = await ingestSample('Audio Test');
  const res = await api('POST', `/api/documents/${meta.id}/audio`, { wait: true });
  assert.equal(res.status, 200, res.text);

  const timeline = res.json.timeline;
  assert.ok(timeline.chunks.length >= 1);
  assert.ok(timeline.words.length > 15);
  assert.equal(timeline.precise, true, 'the local provider places its own words, so timings are exact');
  assert.equal(timeline.sentenceStarts.length, (await api('GET', `/api/documents/${meta.id}`)).json.content.sentences.length);

  // The timeline must end exactly where the audio does.
  const last = timeline.chunks[timeline.chunks.length - 1];
  assert.equal(timeline.durationMs, last.startMs + last.durationMs);

  const audio = await fetch(`${base}${timeline.chunks[0].url}`);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  assert.ok(Number(audio.headers.get('content-length')) > 1000);
});

test('audio chunks honour range requests', async () => {
  const meta = await ingestSample('Range Test');
  const { json } = await api('POST', `/api/documents/${meta.id}/audio`, { wait: true });
  const url = `${base}${json.timeline.chunks[0].url}`;

  const partial = await fetch(url, { headers: { range: 'bytes=0-99' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-length'), '100');
  assert.match(partial.headers.get('content-range'), /^bytes 0-99\/\d+$/);

  const bad = await fetch(url, { headers: { range: 'bytes=99999999-' } });
  assert.equal(bad.status, 416);
});

test('a missing audio chunk is a 404, not a crash', async () => {
  const meta = await ingestSample();
  const res = await api('GET', `/api/documents/${meta.id}/audio/local-clara/0042.wav`);
  assert.equal(res.status, 404);
});

test('seek converts a position into media time', async () => {
  const meta = await ingestSample('Seek Test');
  await api('POST', `/api/documents/${meta.id}/audio`, { wait: true });

  const start = await api('POST', `/api/documents/${meta.id}/seek`, { position: { blockIndex: 0, tokenIndex: 0 } });
  const later = await api('POST', `/api/documents/${meta.id}/seek`, { position: { blockIndex: 2, tokenIndex: 0 } });
  assert.equal(start.json.timeMs, 0);
  assert.ok(later.json.timeMs > start.json.timeMs);
});

test('seeking before synthesis reports a clear conflict', async () => {
  const meta = await ingestSample();
  const res = await api('POST', `/api/documents/${meta.id}/seek`, { position: { blockIndex: 0, tokenIndex: 0 } });
  assert.equal(res.status, 409);
});

test('voices are listed and an unknown voice is rejected', async () => {
  const res = await api('GET', '/api/voices');
  assert.ok(res.json.voices.length >= 1);
  const meta = await ingestSample();
  assert.equal((await api('POST', `/api/documents/${meta.id}/audio`, { voiceId: 'nope' })).status, 400);
});

test('reading state round-trips and increments its revision', async () => {
  const meta = await ingestSample('Sync Test');
  const first = await api('PUT', `/api/sync/state/${meta.id}`, {
    position: { blockIndex: 1, tokenIndex: 3 }, speed: 2, rev: 0, deviceId: 'laptop',
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.state.rev, 1);
  assert.equal(first.json.state.speed, 2);
  assert.ok(first.json.state.progress > 0);

  const second = await api('PUT', `/api/sync/state/${meta.id}`, {
    position: { blockIndex: 2, tokenIndex: 0 }, rev: 1, deviceId: 'phone',
  });
  assert.equal(second.json.state.rev, 2);
  assert.equal(second.json.state.deviceId, 'phone');
});

test('speed is clamped to the supported range', async () => {
  const meta = await ingestSample();
  const tooFast = await api('PUT', `/api/sync/state/${meta.id}`, { position: { blockIndex: 0, tokenIndex: 0 }, speed: 99, rev: 0 });
  const tooSlow = await api('PUT', `/api/sync/state/${meta.id}`, { position: { blockIndex: 0, tokenIndex: 0 }, speed: 0.01, rev: 1 });
  assert.equal(tooFast.json.state.speed, 4.5);
  assert.equal(tooSlow.json.state.speed, 0.5);
});

test('a stale write does not move a reader backwards', async () => {
  const meta = await ingestSample('Stale Write');
  await api('PUT', `/api/sync/state/${meta.id}`, { position: { blockIndex: 2, tokenIndex: 0 }, rev: 0, deviceId: 'phone' });

  // The laptop was offline and still believes it is on revision 0.
  const stale = await api('PUT', `/api/sync/state/${meta.id}`, {
    position: { blockIndex: 0, tokenIndex: 1 }, rev: 0, deviceId: 'laptop',
  });
  // The later write is behind, so the further position survives it.
  assert.equal(stale.json.state.position.blockIndex, 2);
  assert.equal(stale.json.accepted, false, 'the writer should be told its write did not land');
});

test('an offline device that read further still wins', async () => {
  const meta = await ingestSample('Offline Ahead');
  await api('PUT', `/api/sync/state/${meta.id}`, { position: { blockIndex: 1, tokenIndex: 0 }, rev: 0, deviceId: 'laptop' });

  // The phone was offline, so it is on an old revision -- but it read further.
  const ahead = await api('PUT', `/api/sync/state/${meta.id}`, {
    position: { blockIndex: 2, tokenIndex: 2 }, rev: 0, deviceId: 'phone',
  });
  assert.equal(ahead.json.state.position.blockIndex, 2);
  assert.equal(ahead.json.state.position.tokenIndex, 2);
});

test('concurrent writes serialise and converge on the furthest position', async () => {
  const meta = await ingestSample('Concurrent');
  // Twelve devices write at once, all branching from revision 0. Without the
  // per-document lock these interleave and updates are silently dropped.
  const writes = Array.from({ length: 12 }, (_, i) =>
    api('PUT', `/api/sync/state/${meta.id}`, {
      position: { blockIndex: 1, tokenIndex: i }, rev: 0, deviceId: `d${i}`,
    }));
  await Promise.all(writes);

  const final = await api('GET', `/api/sync/state/${meta.id}`);
  assert.equal(final.json.state.position.tokenIndex, 11, 'the furthest write must survive, whatever the arrival order');
  assert.ok(final.json.state.rev >= 1);
  assert.equal(final.json.state.position.blockIndex, 1);
});

test('reading state for an unknown document is a 404', async () => {
  assert.equal((await api('GET', '/api/sync/state/does-not-exist')).status, 404);
  assert.equal((await api('PUT', '/api/sync/state/does-not-exist', { rev: 0 })).status, 404);
});

test('continue-listening lists in-progress documents, newest first', async () => {
  const a = await ingestSample('Continue A');
  const b = await ingestSample('Continue B');
  await api('PUT', `/api/sync/state/${a.id}`, { position: { blockIndex: 1, tokenIndex: 0 }, rev: 0 });
  await api('PUT', `/api/sync/state/${b.id}`, { position: { blockIndex: 1, tokenIndex: 0 }, rev: 0 });

  const res = await api('GET', '/api/documents/continue?limit=5');
  assert.equal(res.status, 200);
  const ids = res.json.documents.map((d) => d.id);
  assert.ok(ids.includes(a.id) && ids.includes(b.id));
  assert.ok(res.json.documents.every((d) => d.state.progress > 0));
});

test('a finished document drops out of continue-listening', async () => {
  const meta = await ingestSample('Finished');
  const doc = await api('GET', `/api/documents/${meta.id}`);
  const lastBlock = doc.json.content.blocks.at(-1);
  await api('PUT', `/api/sync/state/${meta.id}`, {
    position: { blockIndex: lastBlock.index, tokenIndex: lastBlock.tokens.length - 1 }, rev: 0,
  });
  const res = await api('GET', '/api/documents/continue?limit=50');
  assert.ok(!res.json.documents.some((d) => d.id === meta.id));
});

test('highlights can be created, listed and deleted', async () => {
  const meta = await ingestSample('Notes');
  const created = await api('POST', `/api/documents/${meta.id}/highlights`, {
    blockIndex: 1, startToken: 0, endToken: 3, note: 'worth remembering',
  });
  assert.equal(created.status, 201);

  const listed = await api('GET', `/api/documents/${meta.id}/highlights`);
  assert.equal(listed.json.highlights.length, 1);
  assert.equal(listed.json.highlights[0].note, 'worth remembering');

  assert.equal((await api('DELETE', `/api/documents/${meta.id}/highlights/${created.json.highlight.id}`)).status, 200);
  assert.equal((await api('GET', `/api/documents/${meta.id}/highlights`)).json.highlights.length, 0);
});

test('a highlight outside the document is refused', async () => {
  const meta = await ingestSample();
  assert.equal((await api('POST', `/api/documents/${meta.id}/highlights`, { blockIndex: 999 })).status, 400);
});

test('per-user state is isolated', async () => {
  const meta = await ingestSample('Shared Doc');
  await api('PUT', `/api/sync/state/${meta.id}`, { position: { blockIndex: 2, tokenIndex: 0 }, rev: 0 }, { 'x-pagecast-user': 'alice' });
  const bob = await api('GET', `/api/sync/state/${meta.id}`, undefined, { 'x-pagecast-user': 'bob' });
  assert.equal(bob.status, 404, "bob should not see alice's progress");
});

test('malformed JSON is a 400, not a crash', async () => {
  const res = await fetch(`${base}/api/ingest/url`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json',
  });
  assert.equal(res.status, 400);
});

test('CORS preflight is answered', async () => {
  const res = await fetch(`${base}/api/documents`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});
