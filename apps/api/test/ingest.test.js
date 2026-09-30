import test from 'node:test';
import assert from 'node:assert/strict';
import { docxBody, makeZip } from './helpers.js';
import { extractDocx } from '../dist/ingest/docx.js';
import { extractEpub } from '../dist/ingest/epub.js';
import { extractHtml } from '../dist/ingest/html.js';
import { detectKind } from '../dist/ingest/index.js';
import { listEntries, readEntry } from '../dist/ingest/zip.js';
import { decodeEntities, markupToText } from '../dist/ingest/xml.js';

test('zip round-trips a deflated entry', () => {
  const zip = makeZip({ 'a.txt': 'hello world', 'b/c.txt': 'nested' });
  const entries = listEntries(zip);
  assert.equal(entries.length, 2);
  assert.equal(readEntry(zip, entries.find((e) => e.name === 'a.txt')).toString(), 'hello world');
  assert.equal(readEntry(zip, entries.find((e) => e.name === 'b/c.txt')).toString(), 'nested');
});

test('a non-zip buffer is rejected clearly', () => {
  assert.throws(() => listEntries(Buffer.from('definitely not a zip file at all')), /no end-of-central-directory/);
});

test('docx paragraphs, headings and list items are extracted', () => {
  const zip = makeZip({
    'word/document.xml': docxBody([
      { text: 'The Title', style: 'Heading1' },
      { text: 'A first paragraph of body text.' },
      { text: 'a bullet', list: true },
    ]),
    'docProps/core.xml': '<cp:coreProperties xmlns:dc="d"><dc:title>Real Title</dc:title></cp:coreProperties>',
  });
  const out = extractDocx(zip);
  assert.equal(out.title, 'Real Title');
  assert.ok(out.text.includes('# The Title'));
  assert.ok(out.text.includes('A first paragraph of body text.'));
  assert.ok(out.text.includes('- a bullet'));
});

test('docx entities are decoded', () => {
  const zip = makeZip({ 'word/document.xml': docxBody([{ text: 'Caf&#233; &amp; bar' }]) });
  assert.ok(extractDocx(zip).text.includes('Café & bar'));
});

test('a zip that is not a Word document reports why', () => {
  assert.throws(() => extractDocx(makeZip({ 'a.txt': 'x' })), /word\/document\.xml is missing/);
});

test('epub chapters are read in spine order, not zip order', () => {
  const zip = makeZip({
    'META-INF/container.xml': '<container><rootfile full-path="OEBPS/book.opf"/></container>',
    'OEBPS/book.opf': `<package><metadata xmlns:dc="d"><dc:title>My Book</dc:title><dc:creator>An Author</dc:creator></metadata>
      <manifest>
        <item id="c10" href="ch10.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="c2"/><itemref idref="c10"/></spine></package>`,
    'OEBPS/ch2.xhtml': '<html><body><p>Chapter two comes first.</p></body></html>',
    'OEBPS/ch10.xhtml': '<html><body><p>Chapter ten comes second.</p></body></html>',
  });
  const out = extractEpub(zip);
  assert.equal(out.title, 'My Book');
  assert.equal(out.author, 'An Author');
  assert.ok(out.text.indexOf('two comes first') < out.text.indexOf('ten comes second'));
});

test('epub hrefs resolve relative to the package document', () => {
  const zip = makeZip({
    'META-INF/container.xml': '<container><rootfile full-path="OEBPS/x/book.opf"/></container>',
    'OEBPS/x/book.opf': `<package><manifest><item id="a" href="../text/one.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine><itemref idref="a"/></spine></package>`,
    'OEBPS/text/one.xhtml': '<html><body><p>Resolved correctly.</p></body></html>',
  });
  assert.ok(extractEpub(zip).text.includes('Resolved correctly'));
});

test('html extraction picks the article over the navigation', () => {
  const nav = Array.from({ length: 30 }, (_, i) => `<a href="/s/${i}">Section ${i}</a>`).join(' ');
  const html = `<html><head><title>Story Headline | Daily News</title></head><body>
    <nav>${nav}</nav>
    <div class="sidebar">${nav}</div>
    <article><p>${'The substance of the article goes here, with commas, clauses and real prose. '.repeat(6)}</p>
    <p>${'A second paragraph continues the argument at some length, again with commas. '.repeat(6)}</p></article>
    <footer>Copyright notice and more links ${nav}</footer></body></html>`;

  const out = extractHtml(html, 'https://example.com/story');
  assert.equal(out.title, 'Story Headline');
  assert.ok(out.text.includes('substance of the article'));
  assert.ok(!out.text.includes('Section 12'), 'navigation should not survive extraction');
});

test('html extraction prefers og:title and reads the author', () => {
  const html = `<html><head>
    <meta property="og:title" content="The Real Title"/>
    <meta name="author" content="Jane Doe"/>
    <title>fallback</title></head>
    <body><article><p>${'Body prose with commas, and more of it. '.repeat(10)}</p></article></body></html>`;
  const out = extractHtml(html);
  assert.equal(out.title, 'The Real Title');
  assert.equal(out.author, 'Jane Doe');
});

test('markup becomes text with paragraph breaks intact', () => {
  const text = markupToText('<h2>Head</h2><p>One.</p><p>Two.</p><ul><li>item</li></ul>');
  assert.ok(text.includes('## Head'));
  assert.ok(/One\.\n\nTwo\./.test(text));
  assert.ok(text.includes('- item'));
});

test('scripts and styles never reach the reader', () => {
  const text = markupToText('<p>Keep this.</p><script>var secret = 1;</script><style>.x{color:red}</style>');
  assert.ok(text.includes('Keep this.'));
  assert.ok(!text.includes('secret'));
  assert.ok(!text.includes('color:red'));
});

test('entities decode, including numeric and hex forms', () => {
  assert.equal(decodeEntities('a &amp; b &#65; c &#x42; d &mdash; e'), 'a & b A c B d — e');
});

test('an unknown entity is left alone rather than mangled', () => {
  assert.equal(decodeEntities('&notarealentity;'), '&notarealentity;');
});

test('format detection reads magic bytes, not the extension', () => {
  assert.equal(detectKind(Buffer.from('%PDF-1.7\n...'), 'notes.txt'), 'pdf');
  assert.equal(detectKind(makeZip({ 'word/document.xml': '<x/>' }), 'thing.bin'), 'docx');
  assert.equal(detectKind(Buffer.from('plain words'), 'notes.txt'), 'txt');
  assert.equal(detectKind(Buffer.from('<html></html>'), 'page.html'), 'url');
});
