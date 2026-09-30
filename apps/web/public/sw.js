/*
 * Service worker.
 *
 * Two caching rules, because the two kinds of request have opposite needs:
 *
 *   - The app shell (HTML, JS, CSS, icons) is cache-first. It changes only on
 *     deploy, and serving it from disk is what makes the app open instantly
 *     and at all on a train with no signal.
 *
 *   - Everything under /api is network-only, except audio chunks. Reading
 *     state, the library and timelines must never be served stale: a cached
 *     position would silently undo progress made on another device, which is
 *     the one thing cross-device sync exists to prevent.
 *
 *   - Audio chunks are the exception, and are cache-first forever. A given
 *     document, voice and chunk index always produces the same bytes, so they
 *     are immutable by construction.
 */

const SHELL_CACHE = 'pagecast-shell-v1';
const AUDIO_CACHE = 'pagecast-audio-v1';

/** Keep the audio cache bounded; a long book is tens of megabytes. */
const MAX_AUDIO_ENTRIES = 240;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(['/', '/manifest.webmanifest', '/icons/icon-192.png']))
      // A missing asset must not stop the worker installing; the fetch
      // handler falls back to the network for anything not cached.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== AUDIO_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  // Sent on sign-out: the next reader must not find the last one's audio.
  if (event.data === 'pagecast:clear-audio') {
    event.waitUntil(caches.delete(AUDIO_CACHE));
  }
});

const isAudioChunk = (url) => /\/api\/documents\/[^/]+\/audio\//.test(url.pathname);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isAudioChunk(url)) {
    event.respondWith(audioFirst(request));
    return;
  }

  // Never cache the API: a stale position is worse than no position.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(shellFirst(request));
});

async function audioFirst(request) {
  const cache = await caches.open(AUDIO_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  // Range requests come back 206, which cannot be cached usefully; only store
  // a complete body.
  if (response.ok && response.status === 200) {
    await cache.put(request, response.clone());
    void trimAudioCache(cache);
  }
  return response;
}

async function trimAudioCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_AUDIO_ENTRIES) return;
  // Oldest first: cache.keys() preserves insertion order.
  for (const key of keys.slice(0, keys.length - MAX_AUDIO_ENTRIES)) {
    await cache.delete(key);
  }
}

async function shellFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  if (hit) {
    // Refresh in the background so the next launch has the new build.
    void fetch(request).then((response) => {
      if (response.ok) void cache.put(request, response.clone());
    }).catch(() => undefined);
    return hit;
  }

  try {
    const response = await fetch(request);
    if (response.ok && request.destination !== '') {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    // Offline and not cached: fall back to the shell so client-side routes
    // still resolve rather than showing the browser's error page.
    const shell = await cache.match('/');
    if (shell) return shell;
    throw error;
  }
}
