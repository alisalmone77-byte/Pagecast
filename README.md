# Pagecast

Turn any written text — a research PDF, a web article, a page of a paperback —
into high-fidelity audio with word-by-word visual tracking, synchronised across
devices.

Built for people who read a lot and tire of screens: students, professionals,
and readers with ADHD or dyslexia, for whom the combination of *hearing* the
words and *seeing* the current one is the difference between finishing a paper
and abandoning it.

```
packages/core   Shared domain: segmentation, timing, chunking, playback, sync
apps/api        Ingestion, synthesis, delivery, cross-device state  (Node)
apps/web        Library, reader canvas, audio dock                  (React)
apps/ios        Library, scanner, tracking reader, share extension  (SwiftUI)
```

## Quick start

```sh
npm install
npm run build
npm run dev           # API on :8787, web client on :5173
```

Open <http://localhost:5173>, drop in a PDF or paste an article link, and press
play. No credentials are needed: the default text-to-speech provider runs
offline (see [Speech](#speech)).

```sh
npm test              # 116 unit and integration tests, plus the iOS contract check
npm run typecheck     # all three TypeScript workspaces
```

## The one idea worth explaining

**A reading position is a word, never a timestamp.**

Every other design decision follows from this. Audio duration depends on the
voice and the speaking rate, and both differ per device — a laptop at 1× with
one voice and a phone at 2.5× with another produce completely different
timelines for identical text. Sync a number of seconds between them and the
reader lands in the wrong paragraph.

So a `ReadingPosition` is `(blockIndex, tokenIndex)`, and each device converts
to media time locally through its own timeline. The same property makes voice
switching work: change voice mid-document and playback resumes at the same
*word*, not the same second.

## How it fits together

### Ingestion

Format is detected from magic bytes, not the file extension. Each extractor
solves a different problem:

- **PDF** carries no paragraph structure, only positioned glyphs. Paragraphs
  are inferred from vertical gaps and indentation, words split across a line
  break are rejoined, and running heads and page numbers are found by
  detecting short lines that repeat at the same height across many pages —
  reading *"Journal of Cognitive Science, Vol 12"* aloud between every page is
  exactly the fatigue this product exists to remove.
- **EPUB** is read in spine order, because zip order puts chapter 10 before
  chapter 2.
- **HTML** scores candidate containers by prose density against link density,
  which is what separates an article body from a navigation block.
- **DOCX** reads paragraph styles so Word headings become document headings.
- **Camera scans** run Vision OCR over VisionKit's perspective-corrected pages,
  then reassemble lines into paragraphs from their geometry.

### Segmentation

Text becomes blocks, blocks become sentences, sentences become tokens with
character offsets. Sentence splitting handles what real documents contain:
abbreviations (`Dr.`, `et al.`, `3 p.m.`), decimals, initials, and closing
quotes after a terminator. Sentences never span blocks.

### Synthesis

Documents are cut into ~45-second chunks at sentence and paragraph boundaries —
never mid-sentence, because TTS prosody does not line up across two requests
and the seam is audible as a swallowed word.

Chunks render with bounded concurrency and the timeline is rewritten after each
one, so a reader can start playing chunk 0 while chunk 40 is still rendering.
That is the difference between a 50-page PDF being usable in seconds and being
usable in minutes.

### Timing

Word timings come from the TTS provider's own word boundaries where it reports
them. Where it doesn't, they are estimated from a syllable-and-punctuation cost
model and then **normalised against the chunk's real audio duration**. Per-word
error stays in the tens of milliseconds and, critically, cannot accumulate: the
highlight is still locked to the voice on page 50.

### Sync

REST is the source of truth; a WebSocket only pushes what a write already
committed, so a client that cannot hold a socket open loses live updates and
nothing else.

Writes are serialised per document and ordered by a server revision rather than
wall-clock time — a phone that has been in a pocket can easily have a clock a
minute off a laptop's, and a minute is long enough to lose a chapter. A
client's revision is read as *the base it branched from*, not a claim of
authority, so a phone that read half a chapter offline keeps that progress
instead of losing it to whichever device happened to write first. Genuine ties
resolve to the further position: the worst case is one tap to skip back, rather
than silently re-reading.

## Speech

Two providers behind one interface.

**`local`** (the default) needs no credentials and no network. It does not
speak — it renders a soft marker tone per word over exactly the duration that
word is allotted. That makes the entire pipeline runnable and testable in CI,
and makes desynchronised highlighting *audible* rather than something you have
to squint at. It is a development provider, and the UI labels its voices
"(offline)" so nobody mistakes it for the product.

**`openai`** produces real speech:

```sh
export PAGECAST_TTS_PROVIDER=openai
export OPENAI_API_KEY=sk-...
npm run dev:api
```

WAV is requested rather than MP3 so the exact duration can be read off the
header — an MP3 duration derived from bitrate is an estimate, and an estimate
is what puts the highlight progressively out of step.

Adding a provider means implementing `TtsProvider` in `apps/api/src/tts/`. One
that reports word boundaries (Azure, Polly) gets exact timings for free by
returning `marks`; one that doesn't falls back to the fitted estimate.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PAGECAST_PORT` | `8787` | API port |
| `PAGECAST_DATA_DIR` | `./data` | Documents, audio, timelines, reading state |
| `PAGECAST_TTS_PROVIDER` | `local` | `local` or `openai` |
| `OPENAI_API_KEY` | — | Required when the provider is `openai` |
| `PAGECAST_SYNTHESIS_CONCURRENCY` | `2` | Chunks rendered at once |
| `PAGECAST_MAX_UPLOAD_BYTES` | `64MB` | Upload limit |
| `PAGECAST_WEB_DIR` | `apps/web/dist` | Built client, served at `/` |

Storage is JSON files with atomic writes — a deliberate trade for a
single-reader app, keeping the server free of a database dependency while
staying honest about durability. `apps/api/src/store.ts` is the only module
that knows where bytes live; it is the seam to replace for multi-tenancy.

Authentication is a stub: `x-pagecast-user` defaults to `local`. Reading state
and highlights are already partitioned per user, so the change is to the header,
not the model. **Do not expose this to the internet as it stands.**

## Keyboard shortcuts (web)

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `J` / `L` | Back / forward 15 seconds |
| `←` / `→` | Previous / next sentence |
| `↑` / `↓` | Speed ±0.1× |
| `Esc` | Close the open panel, then leave the reader |

## Testing

116 tests across the two TypeScript packages, plus a cross-language contract
check for iOS.

The interesting ones are the invariants rather than the units: that sentences
tile every block with no gaps, that position and time round-trip through the
timeline in both directions, that the tinted sentence always contains the
pilled word, that estimation error cannot accumulate across a chunk boundary,
and that concurrent writes from twelve devices converge on the furthest
position whatever order they arrive in.

The web client was also driven end-to-end in Chromium against the real server,
which is where four bugs that unit tests could not have found turned up — most
of them in the seam between React's render cycle and a clock that ticks
independently of it.

## Status

Working and verified: ingestion for all five formats, synthesis and chunked
delivery, the web reader with word-level tracking, cross-device sync, themes
and typography including OpenDyslexic.

**The iOS sources have not been compiled** — they were written in a Linux
container with no Swift toolchain. The wire contract is verified against real
server payloads by a check that runs in `npm test`; the Swift around it has
never seen a compiler. `apps/ios/README.md` has the detail.

Not built: folders (the field exists and is plumbed through, nothing creates
them), real authentication, and CloudKit sync as an alternative to REST.

## Licence

MIT
