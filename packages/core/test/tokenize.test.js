import test from 'node:test';
import assert from 'node:assert/strict';
import { blocksFromText, parseText, sentenceText, tokenize, totalWords } from '../dist/index.js';

test('tokenize keeps internal apostrophes and hyphens but drops edge marks', () => {
  const tokens = tokenize(`It's a well-known fact -- really.`);
  assert.deepEqual(tokens.map((t) => t.text), ["It's", 'a', 'well-known', 'fact', 'really']);
});

test('tokenize reports offsets that index back into the source text', () => {
  const text = 'Alpha beta gamma';
  for (const t of tokenize(text)) {
    assert.equal(text.slice(t.start, t.end), t.text);
  }
});

test('tokenize handles non-latin scripts', () => {
  assert.deepEqual(tokenize('日本語 のテキスト').map((t) => t.text), ['日本語', 'のテキスト']);
  assert.deepEqual(tokenize('Привет мир').map((t) => t.text), ['Привет', 'мир']);
});

test('blank lines separate blocks, single newlines are soft wraps', () => {
  const blocks = blocksFromText('One sentence that\nwraps across lines.\n\nA second paragraph.');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, 'One sentence that wraps across lines.');
  assert.equal(blocks[1].text, 'A second paragraph.');
});

test('hyphenated words split by a line break are rejoined', () => {
  const blocks = blocksFromText('The experi-\nmental results were clear.');
  assert.equal(blocks[0].text, 'The experimental results were clear.');
});

test('headings are detected from markdown and from shape', () => {
  const blocks = blocksFromText('# Chapter One\n\nBody text follows here.\n\nMethods And Materials\n\nMore body text.');
  assert.equal(blocks[0].type, 'heading1');
  assert.equal(blocks[0].text, 'Chapter One');
  assert.equal(blocks[1].type, 'paragraph');
  assert.equal(blocks[2].type, 'heading2');
});

test('list items stay one block each', () => {
  const blocks = blocksFromText('- first item\n- second item\n- third item');
  assert.equal(blocks.length, 3);
  assert.ok(blocks.every((b) => b.type === 'listItem'));
  assert.equal(blocks[1].text, 'second item');
});

test('sentences split on terminators', () => {
  const content = parseText('First one. Second one! Third one? Fourth.');
  assert.equal(content.sentences.length, 4);
  assert.equal(sentenceText(content, 1), 'Second one');
});

test('abbreviations do not end a sentence', () => {
  const content = parseText('Dr. Smith met Mr. Jones at 3 p.m. They spoke briefly.');
  assert.equal(content.sentences.length, 2);
  assert.ok(sentenceText(content, 0).startsWith('Dr. Smith'));
});

test('citation style abbreviations survive', () => {
  const content = parseText('As shown by Kohn et al. the effect is small. We replicate it here.');
  assert.equal(content.sentences.length, 2);
});

test('decimals do not end a sentence', () => {
  const content = parseText('The value was 3.14 across trials. That surprised us.');
  assert.equal(content.sentences.length, 2);
});

test('a lowercase word after a period is treated as mid-sentence', () => {
  const content = parseText('See fig. 4 for the breakdown of results.');
  assert.equal(content.sentences.length, 1);
});

test('closing quotes stay with the sentence that ends', () => {
  const content = parseText('He said "Stop that!" Then he left the room.');
  assert.equal(content.sentences.length, 2);
  assert.ok(sentenceText(content, 0).includes('Stop that'));
});

test('sentences never span blocks', () => {
  const content = parseText('An unterminated line\n\nAnother unterminated line');
  assert.equal(content.sentences.length, 2);
  assert.equal(content.sentences[0].blockIndex, 0);
  assert.equal(content.sentences[1].blockIndex, 1);
});

test('every sentence range is non-empty and covers its block exactly once', () => {
  const content = parseText(
    'Alpha beta. Gamma delta epsilon! Zeta?\n\nSecond block here. And more of it.\n\n# Heading\n\nTail.',
  );
  const seen = new Map();
  for (const s of content.sentences) {
    assert.ok(s.endToken > s.startToken, 'sentence must contain at least one token');
    const covered = seen.get(s.blockIndex) ?? 0;
    assert.equal(s.startToken, covered, 'sentences must tile the block with no gaps');
    seen.set(s.blockIndex, s.endToken);
  }
  for (const block of content.blocks) {
    assert.equal(seen.get(block.index), block.tokens.length, 'sentences must cover the whole block');
  }
});

test('totalWords counts every token', () => {
  const content = parseText('One two three.\n\nFour five.');
  assert.equal(totalWords(content), 5);
});

test('empty and whitespace-only input produce no blocks', () => {
  assert.equal(parseText('').blocks.length, 0);
  assert.equal(parseText('   \n\n  \t ').blocks.length, 0);
});
