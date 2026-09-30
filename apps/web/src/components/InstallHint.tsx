import { useEffect, useState } from 'react';
import { isIOS, isStandalone } from '../pwa.js';

/**
 * A one-line nudge to install to the Home Screen, shown only on iOS Safari.
 *
 * iOS has no `beforeinstallprompt`, so there is no button that can do this --
 * the reader has to use the Share menu, and the only useful thing the app can
 * do is say where it is. Dismissal is remembered, because a banner that comes
 * back is worse than no banner.
 */
const DISMISSED_KEY = 'pagecast.installHintDismissed';

export function InstallHint() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isIOS() || isStandalone()) return;
    try {
      if (localStorage.getItem(DISMISSED_KEY) === '1') return;
    } catch {
      // Storage blocked: showing it once per session is acceptable.
    }
    setVisible(true);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    try { localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* storage blocked */ }
  };

  return (
    <div className="install-hint" role="note">
      <ShareIcon />
      <span>
        <strong>Add Pagecast to your Home Screen</strong> — tap Share, then
        “Add to Home Screen”, for a full-screen reader that opens instantly.
      </span>
      <button type="button" onClick={dismiss} aria-label="Dismiss">×</button>
    </div>
  );
}

function ShareIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 16V4" />
      <path d="m8 8 4-4 4 4" />
      <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
    </svg>
  );
}
