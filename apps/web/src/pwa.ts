/**
 * Progressive web app plumbing.
 *
 * Registered only for a production build: in dev the service worker would
 * serve a stale bundle back over Vite's hot reload, which looks exactly like
 * the app being broken.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (!import.meta.env.PROD) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      // Not fatal: without it the app simply has no offline shell.
      console.warn('[pagecast] service worker registration failed:', error);
    });
  });
}

/** Drop cached audio. Called on sign-out: it is the previous reader's. */
export function clearCachedAudio(): void {
  navigator.serviceWorker?.controller?.postMessage('pagecast:clear-audio');
}

/**
 * True when running from the Home Screen rather than in a browser tab.
 *
 * iOS reports this through a non-standard `navigator.standalone`; everywhere
 * else it is a media query.
 */
export function isStandalone(): boolean {
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    return (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/** True on an iPhone or iPad, including iPadOS reporting itself as a Mac. */
export function isIOS(): boolean {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}
