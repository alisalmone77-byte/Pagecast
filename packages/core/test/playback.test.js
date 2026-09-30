import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeSpanAtTime, buildTimeline, chunksToPrefetch, clampPosition, comparePositions,
  fitPlan, fromGlobalWordIndex, parseText, planSentences, positionAtTime, progressAt,
  remainingSeconds, resumeTarget, seekBySentence, sentenceAtPosition, skipSeconds,
  timeAtPosition, toGlobalWordIndex, wordIndexAtTime,
} from '../dist/index.js';

const TEXT = 'Alpha beta gamma. Delta epsilon zeta.\n\nEta theta iota. Kappa lambda mu.';

function build(durationMs = 20_000) {
  const content = parseText(TEXT);
  const plan = planSentences(content, 0, content.sentences.length);
  const words = fitPlan(plan, durationMs, 0);
  const chunk = {
    index: 0, startMs: 0, durationMs, url: '/a.mp3',
    startSentence: 0, endSentence: content.sentences.length,
  };
  return { content, timeline: buildTimeline('v1', [{ chunk, words }], content, false) };
}

test('position and time round-trip through the timeline', () => {
  const { timeline } = build();
  for (const word of timeline.words) {
    const pos = { blockIndex: word.blockIndex, tokenIndex: word.tokenIndex };
    assert.equal(timeAtPosition(timeline, pos), word.startMs);
    assert.deepEqual(positionAtTime(timeline, word.startMs), pos);
  }
});

test('time lookups clamp at both ends', () => {
  const { timeline } = build();
  assert.equal(wordIndexAtTime(timeline, -5_000), 0);
  assert.equal(wordIndexAtTime(timeline, 999_999), timeline.words.length - 1);
});

test('the active span reports progress through the current word', () => {
  const { timeline } = build();
  const word = timeline.words[3];
  const mid = word.startMs + (word.endMs - word.startMs) / 2;
  const span = activeSpanAtTime(timeline, mid);
  assert.equal(span.blockIndex, word.blockIndex);
  assert.equal(span.tokenIndex, word.tokenIndex);
  assert.ok(span.wordProgress > 0.4 && span.wordProgress < 0.6);
});

test('the active sentence follows the active word', () => {
  const { content, timeline } = build();
  for (const word of timeline.words) {
    const span = activeSpanAtTime(timeline, word.startMs);
    const sentence = content.sentences[span.sentenceIndex];
    assert.equal(sentence.blockIndex, word.blockIndex, 'highlighted sentence must be in the spoken block');
    assert.ok(word.tokenIndex >= sentence.startToken && word.tokenIndex < sentence.endToken,
      `word ${word.tokenIndex} outside sentence [${sentence.startToken},${sentence.endToken})`);
  }
});

test('global word index round-trips', () => {
  const { content } = build();
  const total = content.blocks.reduce((n, b) => n + b.tokens.length, 0);
  for (let i = 0; i < total; i += 1) {
    assert.equal(toGlobalWordIndex(content, fromGlobalWordIndex(content, i)), i);
  }
});

test('progress runs from zero to one across the document', () => {
  const { content } = build();
  assert.equal(progressAt(content, { blockIndex: 0, tokenIndex: 0 }), 0);
  const last = content.blocks[content.blocks.length - 1];
  assert.ok(progressAt(content, { blockIndex: last.index, tokenIndex: last.tokens.length - 1 }) > 0.8);
});

test('positions are clamped onto real words', () => {
  const { content } = build();
  assert.deepEqual(clampPosition(content, { blockIndex: -4, tokenIndex: -9 }), { blockIndex: 0, tokenIndex: 0 });
  const clamped = clampPosition(content, { blockIndex: 99, tokenIndex: 99 });
  assert.equal(clamped.blockIndex, content.blocks.length - 1);
  assert.equal(clamped.tokenIndex, content.blocks[clamped.blockIndex].tokens.length - 1);
});

test('resume drops back to the start of the current sentence', () => {
  const { content } = build();
  // Second sentence of the first block starts at token 3.
  const resumed = resumeTarget(content, { blockIndex: 0, tokenIndex: 4 });
  assert.deepEqual(resumed, { blockIndex: 0, tokenIndex: 3 });
});

test('resuming at a sentence start is a no-op', () => {
  const { content } = build();
  assert.deepEqual(resumeTarget(content, { blockIndex: 1, tokenIndex: 0 }), { blockIndex: 1, tokenIndex: 0 });
});

test('sentence seeking moves forward and back and clamps at the edges', () => {
  const { content } = build();
  const start = { blockIndex: 0, tokenIndex: 0 };
  assert.equal(sentenceAtPosition(content, seekBySentence(content, start, 1)), 1);
  assert.equal(sentenceAtPosition(content, seekBySentence(content, start, -1)), 0);
  assert.equal(sentenceAtPosition(content, seekBySentence(content, start, 999)), content.sentences.length - 1);
});

test('a fifteen second skip moves fifteen seconds of media time at any speed', () => {
  const { timeline } = build();
  assert.equal(skipSeconds(timeline, 5_000, 15), 20_000);
  assert.equal(skipSeconds(timeline, 5_000, -15), 0);
  assert.equal(skipSeconds(timeline, 19_000, 15), timeline.durationMs);
});

test('prefetch widens the lookahead as speed increases', () => {
  const content = parseText(Array.from({ length: 200 }, (_, i) => `Sentence ${i} here.`).join(' '));
  const parts = [];
  for (let i = 0; i < 10; i += 1) {
    parts.push({
      chunk: { index: i, startMs: i * 30_000, durationMs: 30_000, url: `/${i}.mp3`, startSentence: i, endSentence: i + 1 },
      words: [],
    });
  }
  const timeline = buildTimeline('v1', parts, content, false);
  const slow = chunksToPrefetch(timeline, 0, 1);
  const fast = chunksToPrefetch(timeline, 0, 4.5);
  assert.ok(fast.length > slow.length, 'faster playback should prefetch further ahead');
});

test('remaining time shrinks as speed rises', () => {
  const { content } = build();
  const pos = { blockIndex: 0, tokenIndex: 0 };
  assert.ok(remainingSeconds(content, pos, 160, 2) < remainingSeconds(content, pos, 160, 1));
});

test('positions compare in reading order', () => {
  assert.ok(comparePositions({ blockIndex: 1, tokenIndex: 0 }, { blockIndex: 0, tokenIndex: 99 }) > 0);
  assert.ok(comparePositions({ blockIndex: 0, tokenIndex: 1 }, { blockIndex: 0, tokenIndex: 2 }) < 0);
  assert.equal(comparePositions({ blockIndex: 2, tokenIndex: 3 }, { blockIndex: 2, tokenIndex: 3 }), 0);
});
