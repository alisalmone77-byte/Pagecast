import { useEffect, useState } from 'react';
import type { AudioEngine } from './audioEngine.js';

/**
 * A ticking read of the playhead for the UI.
 *
 * The engine only notifies subscribers when something *changes* -- status,
 * buffering, an error -- because pushing a React update for every audio frame
 * would re-render the whole dock 60 times a second. But the elapsed time and
 * the scrubber do have to move continuously, so they get their own clock here.
 *
 * Updates are quantised to 100ms: fine enough that the thumb glides and the
 * seconds readout never skips, coarse enough that a long document costs ten
 * small re-renders a second instead of sixty.
 */
export function usePlayerClock(engine: AudioEngine, playing: boolean): number {
  const [ms, setMs] = useState(() => engine.currentMs());

  useEffect(() => {
    if (!playing) {
      // Settle on the exact paused position rather than the last tick.
      setMs(engine.currentMs());
      return;
    }

    let frame = 0;
    let lastQuantum = -1;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const current = engine.currentMs();
      const quantum = Math.round(current / 100);
      if (quantum !== lastQuantum) {
        lastQuantum = quantum;
        setMs(current);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [engine, playing]);

  return ms;
}
