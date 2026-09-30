# Pagecast for iOS

SwiftUI client for the Pagecast API. Four screens, matching the spec: library
and quick launch, the VisionKit scanner, the tracking reader, and the audio
sheet — plus a Safari share extension and lock-screen controls.

## Status

**These sources have not been compiled.** They were written in a Linux
container with no Swift toolchain and no Xcode. Expect to fix some diagnostics
on the first build; nothing here has run on a device.

They have been through a careful review pass since, which found and fixed six
real defects. They are listed because they are the kinds of thing that compile
cleanly and then behave wrongly, so they are worth knowing about if you are
reading this code:

- `ReaderSettings` used `@AppStorage` inside an `ObservableObject`.
  `@AppStorage` is a `DynamicProperty`: it only works inside a `View`, where
  SwiftUI installs it. Every reading preference would have appeared to save and
  then silently failed to apply. Now backed by `UserDefaults` directly.
- `ReaderView` rebuilt the entire document's `NSAttributedString` inside `body`.
  Since the active word is `@Published`, that meant re-rendering a 50-page
  document several times a second. Now built once per document or appearance
  change, off the main actor.
- The mini-player and audio sheet read playback state through `ReaderModel`, so
  nothing observed `PlaybackEngine` and the clock and scrubber never moved.
  They observe the engine directly now. (The web client had the same bug.)
- `TrackingTextView` touched `layoutManager`, which silently falls a TextKit 2
  view back to TextKit 1 — after paying for TextKit 2 layout on open. It now
  opts into TextKit 1 explicitly, which is what the tap handling and
  auto-scroll actually need.
- The coordinator compared `NSAttributedString.hashValue` to decide whether to
  replace the text, which walks every character of the document on each update.
  It compares an explicit revision counter instead.
- The folder filter was a `String??`, where `.some(nil)` meant Unfiled and
  `nil` meant no filter. One misplaced `.some` shows the wrong documents; it is
  an explicit enum now.

What *is* verified is the part that can be, and it is the part most likely to
break silently: the wire contract with the server. See
[Verification](#verification) below.

## Building

The Xcode project is generated rather than committed — `.pbxproj` is
unreviewable in a diff and conflicts on every concurrent change.

```sh
brew install xcodegen
cd apps/ios
xcodegen generate
open Pagecast.xcodeproj
```

Point the app at your server by editing `PAGECAST_API_BASE` in
`Pagecast/Info.plist` (and the same key in the extension's plist). It defaults
to `http://localhost:8787`, which works in the simulator against
`npm run dev:api`. On a physical device use your machine's LAN address.

Both targets share a keychain group so the share extension can use the signed-in
session without asking anyone to sign in twice. Set your team's prefix on the
`keychain-access-groups` entitlement in both `.entitlements` files, or sharing
from Safari will report that you need to sign in.

`NSAllowsLocalNetworking` is set so a plaintext development server works.
A production build talks to https and should drop that key.

To ship the OpenDyslexic option, add `OpenDyslexic-Regular.otf` to the app
target and list it under `UIAppFonts`. Without it the typeface picker falls
back to the system face rather than silently rendering in something else.

## Verification

`PagecastTests` decodes payloads captured from a real running server rather
than hand-written JSON, and asserts the invariants the reader depends on:
token offsets index back into their block, tokens plus gaps reproduce the
paragraph exactly, sentences tile every block, position and time round-trip
through the timeline, the tinted sentence always contains the pilled word, and
progress spans a full 0 to 1.

Those tests need Xcode. The same invariants are also asserted by
`PagecastTests/Support/verify_fixtures.py`, which runs anywhere:

```sh
python3 PagecastTests/Support/verify_fixtures.py
```

That script is what stands in for a compiler here. It currently passes, which
means the logic ported into `TimelineIndex` and `Block.gap(after:)` is correct
against real data — not that the Swift around it compiles.

Re-capture fixtures after changing the API:

```sh
npm run dev:api                                   # from the repo root
PagecastTests/Support/capture_fixtures.sh
```

## Notes on the design

**Positions are words, not seconds.** A `ReadingPosition` is a
`(blockIndex, tokenIndex)` pair. Audio duration depends on voice and speaking
rate, both of which differ between a Mac and a phone, so seconds do not survive
a hand-off — a word index does. Each device converts to media time locally
through its own `TimelineIndex`. This is also why switching voices mid-document
resumes on the same word rather than the same timestamp.

**The reader is a `UITextView`, not a stack of SwiftUI `Text`.** Two of the
spec's requirements force it: tapping a word to seek needs per-character hit
testing, which SwiftUI's `Text` does not expose but TextKit does exactly; and
moving the highlight 30 times a second has to mutate attributes on existing
text storage rather than rebuild a view tree of 25,000 spans. On iOS 16+
`UITextView` is backed by TextKit 2 and lays out only the visible viewport, so
a 50-page document opens without a stall.

**Playback is `AVQueuePlayer`, not `AVAudioEngine`.** This app never mixes or
processes audio — it plays a sequence of files at a variable rate and needs to
know exactly where it is. `AVQueuePlayer` gives gapless chunk transitions,
background playback, route changes, interruptions and the Now Playing controls
for free. Position is queried from a `CADisplayLink` rather than a periodic
observer, so the highlight resolves for the frame about to be drawn.

**The share extension posts to the API itself** instead of handing off to the
app. Sharing from Safari should not mean watching another app launch; the
article is waiting in the library next time Pagecast is opened.

**Audio chunks cache to disk forever.** A given document, voice and chunk index
always produces the same audio, so cached chunks are immutable and only evicted
for space. A commute is exactly when someone wants this app and exactly when
the network is worst. Signing out clears the cache, because it is someone
else's reading.

**The session token lives in the keychain, not `UserDefaults`.** `UserDefaults`
is a plist in the app container: readable from a file-system backup, and not
protected while the device is locked. `kSecAttrAccessibleAfterFirstUnlock`
keeps the token available to background audio and background sync after the
first unlock following a reboot, without leaving it readable on a device that
has never been unlocked.
