import type { AudioEngine } from './audioEngine.js';

/**
 * Lock screen and headset controls.
 *
 * Without this, a phone shows "pagecast.app" playing with no title and the
 * headset's play/pause button does nothing. With it, the document appears with
 * its title and the hardware controls work.
 *
 * Note the honest limit on iOS: Safari suspends an AudioContext when the app
 * is backgrounded, so this makes the controls *correct* while the page is in
 * front, but does not make Web Audio keep playing with the screen off. That is
 * what the native client is for.
 */

export interface MediaSessionInfo {
  readonly title: string;
  readonly author?: string;
}

export function attachMediaSession(
  engine: AudioEngine,
  info: MediaSessionInfo,
  actions: {
    play(): void;
    pause(): void;
    skip(seconds: number): void;
    seekTo(ms: number): void;
  },
): () => void {
  const session = navigator.mediaSession;
  if (!session) return () => undefined;

  try {
    session.metadata = new MediaMetadata({
      title: info.title,
      artist: info.author ?? 'Pagecast',
      album: 'Pagecast',
      artwork: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  } catch {
    // MediaMetadata is unavailable in some engines; controls still work.
  }

  const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
    ['play', () => actions.play()],
    ['pause', () => actions.pause()],
    ['seekbackward', (details) => actions.skip(-(details.seekOffset ?? 15))],
    ['seekforward', (details) => actions.skip(details.seekOffset ?? 15)],
    ['previoustrack', () => actions.skip(-15)],
    ['nexttrack', () => actions.skip(15)],
    ['seekto', (details) => {
      if (typeof details.seekTime === 'number') actions.seekTo(details.seekTime * 1000);
    }],
  ];

  for (const [action, handler] of handlers) {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // An unsupported action throws; the rest still register.
    }
  }

  const unsubscribe = engine.subscribe((snapshot) => {
    session.playbackState = snapshot.status === 'playing' ? 'playing' : 'paused';
    if (snapshot.durationMs <= 0) return;
    try {
      session.setPositionState({
        duration: snapshot.durationMs / 1000,
        playbackRate: snapshot.speed,
        position: Math.min(snapshot.mediaMs, snapshot.durationMs) / 1000,
      });
    } catch {
      // Throws if position exceeds duration during a seek; harmless.
    }
  });

  return () => {
    unsubscribe();
    for (const [action] of handlers) {
      try { session.setActionHandler(action, null); } catch { /* ignore */ }
    }
    try { session.metadata = null; } catch { /* ignore */ }
    session.playbackState = 'none';
  };
}
