import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimeline, fitPlan, marksToTimings, parseText, planChunks, planSentences, syllables, wordCost,
} from '../dist/index.js';

const PROSE = 'The quick brown fox jumps. It lands softly, then waits. A second paragraph begins here.';

function timelineFor(text, durationMs = 10_000) {
  const content = parseText(text);
  const plan = planSentences(content, 0, content.sentences.length);
  const words = fitPlan(plan, durationMs, 0);
  const chunk = {
    index: 0, startMs: 0, durationMs, url: '/a.mp3',
    startSentence: 0, endSentence: content.sentences.length,
  };
  return { content, timeline: buildTimeline('v1', [{ chunk, words }], content, false) };
}

test('syllable estimates are in the right neighbourhood', () => {
  assert.equal(syllables('cat'), 1);
  assert.equal(syllables('running'), 2);
  assert.ok(syllables('information') >= 3);
});

test('numbers cost more than their character count suggests', () => {
  assert.ok(wordCost('2024') > wordCost('four'));
});

test('fitPlan exactly fills the audio duration', () => {
  const { timeline } = timelineFor(PROSE, 12_345);
  const last = timeline.words[timeline.words.length - 1];
  assert.equal(last.endMs, 12_345);
});

test('fitPlan produces a monotonically increasing, gapless timeline', () => {
  const { timeline } = timelineFor(PROSE);
  for (let i = 1; i < timeline.words.length; i += 1) {
    assert.ok(timeline.words[i].startMs >= timeline.words[i - 1].startMs, 'starts must not go backwards');
    assert.ok(timeline.words[i].endMs >= timeline.words[i].startMs, 'a word must not end before it starts');
  }
});

test('longer words get more time than shorter ones', () => {
  const { timeline } = timelineFor('Cat extraordinarily cat.');
  const [a, b] = timeline.words;
  assert.ok(b.endMs - b.startMs > a.endMs - a.startMs);
});

test('estimation error does not accumulate across chunks', () => {
  // Two chunks of very different word lengths, each pinned to a known duration.
  const content = parseText('Cat cat cat cat cat.\n\nExtraordinarily complicated terminology throughout.');
  const parts = [];
  let offset = 0;
  for (const [i, range] of [[0, 1], [1, 2]].entries()) {
    const plan = planSentences(content, range[0], range[1]);
    const durationMs = 5_000;
    parts.push({
      chunk: { index: i, startMs: offset, durationMs, url: `/${i}.mp3`, startSentence: range[0], endSentence: range[1] },
      words: fitPlan(plan, durationMs, offset),
    });
    offset += durationMs;
  }
  const timeline = buildTimeline('v1', parts, content, false);
  assert.equal(timeline.durationMs, 10_000);
  // The seam is exact regardless of how wrong the per-word estimate was.
  const firstOfSecondChunk = timeline.words.find((w) => w.startMs >= 5_000);
  assert.equal(firstOfSecondChunk.startMs, 5_000);
});

test('pauses are scaled down rather than going negative on very short audio', () => {
  const { timeline } = timelineFor('A. B. C. D. E.', 200);
  for (const w of timeline.words) {
    assert.ok(w.endMs >= w.startMs, 'no negative-length words');
    assert.ok(w.startMs >= 0);
  }
});

test('provider marks are offset onto the document timeline', () => {
  const marks = [
    { blockIndex: 0, tokenIndex: 0, startMs: 0, endMs: 300 },
    { blockIndex: 0, tokenIndex: 1, startMs: 300, endMs: 700 },
  ];
  const out = marksToTimings(marks, 1000, 5_000);
  assert.deepEqual(out.map((w) => [w.startMs, w.endMs]), [[5000, 5300], [5300, 5700]]);
});

test('a mark with no end time runs up to the next mark', () => {
  const out = marksToTimings(
    [{ blockIndex: 0, tokenIndex: 0, startMs: 0 }, { blockIndex: 0, tokenIndex: 1, startMs: 400 }],
    900, 0,
  );
  assert.equal(out[0].endMs, 400);
  assert.equal(out[1].endMs, 900);
});

test('chunk planning never splits a sentence', () => {
  const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} carries a reasonable amount of text.`).join(' ');
  const content = parseText(long);
  const chunks = planChunks(content);
  assert.ok(chunks.length > 1, 'a long document should produce several chunks');
  let expected = 0;
  for (const chunk of chunks) {
    assert.equal(chunk.startSentence, expected, 'chunks must tile the sentence list');
    assert.ok(chunk.endSentence > chunk.startSentence);
    expected = chunk.endSentence;
  }
  assert.equal(expected, content.sentences.length, 'chunks must cover every sentence');
});

test('chunk text carries terminal punctuation through to the provider', () => {
  const content = parseText('Is this a question? Yes it is!');
  const [chunk] = planChunks(content);
  assert.ok(chunk.text.includes('question?'));
  assert.ok(chunk.text.includes('is!'));
});

test('chunk planning handles a single short document', () => {
  const content = parseText('Just one line.');
  const chunks = planChunks(content);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startSentence, 0);
  assert.equal(chunks[0].endSentence, 1);
});

test('chunk planning on an empty document returns nothing', () => {
  assert.deepEqual(planChunks(parseText('')), []);
});
