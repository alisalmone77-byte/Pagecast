import { useEffect, useRef } from 'react';
import { activeSpanAtTime, type ActiveSpan, type Timeline } from '@pagecast/core';
import type { AudioEngine } from './audioEngine.js';

/**
 * Word- and sentence-level highlighting, driven off requestAnimationFrame.
 *
 * This deliberately writes to the DOM directly instead of going through React
 * state. A 50-page document is on the order of 25,000 token elements; asking
 * React to reconcile that tree 60 times a second would drop frames on any
 * machine, and the highlight would visibly lag the voice -- which is the one
 * thing this product cannot get wrong.
 *
 * Instead the token elements are rendered once, keyed by data attributes, and
 * each frame touches exactly the elements that changed: the word leaving, the
 * word arriving, and the sentence if it moved. That is at most four class
 * mutations per frame regardless of document length.
 */

export interface KaraokeOptions {
  readonly autoScroll: boolean;
  readonly sentenceHighlight: boolean;
  /** Called when the active word moves, for progress reporting and sync. */
  readonly onWordChange?: (span: ActiveSpan) => void;
}

const WORD_CLASS = 'token--active';
const SENTENCE_CLASS = 'block__sentence--active';

/**
 * `container` is the element itself rather than a ref, so the effect re-runs the
 * moment the canvas mounts. Taking a ref here meant the effect ran once while
 * the document was still loading, found `ref.current` null, and bailed out
 * permanently -- the highlight then never started on any document that did not
 * load synchronously, which is all of them.
 */
export function useKaraoke(
  container: HTMLElement | null,
  engine: AudioEngine,
  timeline: Timeline | null,
  options: KaraokeOptions,
): void {
  // Held in refs so changing a setting does not restart the animation loop.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

  useEffect(() => {
    if (!container) return;

    let frame = 0;
    let activeWord: HTMLElement | null = null;
    let activeSentence: HTMLElement | null = null;
    let lastWordIndex = -1;
    let lastSentenceIndex = -1;
    let lastScrolledBlock = -1;

    const clear = () => {
      activeWord?.classList.remove(WORD_CLASS);
      activeSentence?.classList.remove(SENTENCE_CLASS);
      activeWord = null;
      activeSentence = null;
    };

    const tick = () => {
      frame = requestAnimationFrame(tick);

      const currentTimeline = timelineRef.current;
      if (!currentTimeline || currentTimeline.words.length === 0) return;

      const span = activeSpanAtTime(currentTimeline, engine.currentMs());
      if (!span) return;

      if (span.wordIndex !== lastWordIndex) {
        lastWordIndex = span.wordIndex;

        const next = container.querySelector<HTMLElement>(
          `[data-b="${span.blockIndex}"][data-t="${span.tokenIndex}"]`,
        );
        if (next !== activeWord) {
          activeWord?.classList.remove(WORD_CLASS);
          next?.classList.add(WORD_CLASS);
          activeWord = next;
        }
        optionsRef.current.onWordChange?.(span);
      }

      if (span.sentenceIndex !== lastSentenceIndex) {
        lastSentenceIndex = span.sentenceIndex;
        activeSentence?.classList.remove(SENTENCE_CLASS);
        activeSentence = null;

        if (optionsRef.current.sentenceHighlight) {
          const next = container.querySelector<HTMLElement>(`[data-sentence="${span.sentenceIndex}"]`);
          next?.classList.add(SENTENCE_CLASS);
          activeSentence = next;
        }
      }

      // Scroll on block changes only. Following every word would make the page
      // twitch continuously, which is precisely the visual fatigue this is
      // meant to remove.
      if (optionsRef.current.autoScroll && span.blockIndex !== lastScrolledBlock && activeWord) {
        lastScrolledBlock = span.blockIndex;
        keepInComfortBand(activeWord);
      }
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      clear();
    };
  }, [container, engine]);
}

/**
 * Scroll only when the reader is drifting out of a comfortable band.
 *
 * The band is the middle of the viewport, biased slightly high so there is
 * always upcoming text visible below the voice. Scrolling only on exit means
 * long paragraphs sit still while they are read.
 */
function keepInComfortBand(element: HTMLElement): void {
  const scroller = findScrollParent(element);
  if (!scroller) return;

  const elementBox = element.getBoundingClientRect();
  const scrollBox =
    scroller === document.scrollingElement
      ? { top: 0, height: window.innerHeight }
      : { top: scroller.getBoundingClientRect().top, height: scroller.clientHeight };

  const relativeTop = elementBox.top - scrollBox.top;
  const upperBound = scrollBox.height * 0.22;
  const lowerBound = scrollBox.height * 0.62;
  if (relativeTop >= upperBound && relativeTop <= lowerBound) return;

  const target = scroller.scrollTop + relativeTop - scrollBox.height * 0.34;
  scroller.scrollTo({
    top: Math.max(0, target),
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  });
}

function findScrollParent(element: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = element.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
