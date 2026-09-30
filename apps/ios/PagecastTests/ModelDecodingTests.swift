import XCTest
@testable import Pagecast

//  The Swift model is written by hand rather than generated from the
//  TypeScript, so the wire format is the only contract between the two. These
//  fixtures are real responses captured from a running server; decoding them is
//  what stops the two definitions drifting apart silently.

final class ModelDecodingTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let bundle = Bundle(for: Self.self)
        guard let url = bundle.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
                ?? bundle.url(forResource: name, withExtension: "json") else {
            XCTFail("missing fixture \(name).json")
            throw CocoaError(.fileNoSuchFile)
        }
        return try Data(contentsOf: url)
    }

    func testDecodesFullDocument() throws {
        let document = try JSONDecoder().decode(FullDocument.self, from: fixture("document"))

        XCTAssertFalse(document.content.blocks.isEmpty)
        XCTAssertFalse(document.content.sentences.isEmpty)
        XCTAssertEqual(document.meta.wordCount, document.content.wordCount)
        XCTAssertEqual(document.content.blocks.first?.type, .heading1)
    }

    func testBlockTypesAllDecode() throws {
        // An unrecognised block type would throw, which is the point: a server
        // that starts emitting a new kind should fail loudly in tests here
        // rather than quietly render nothing on a reader's phone.
        let document = try JSONDecoder().decode(FullDocument.self, from: fixture("document"))
        for block in document.content.blocks {
            XCTAssertFalse(block.text.isEmpty)
            XCTAssertFalse(block.tokens.isEmpty)
        }
    }

    func testTokenOffsetsIndexBackIntoTheirBlock() throws {
        let document = try JSONDecoder().decode(FullDocument.self, from: fixture("document"))
        for block in document.content.blocks {
            let utf16 = Array(block.text.utf16)
            for token in block.tokens {
                XCTAssertLessThanOrEqual(token.end, utf16.count)
                let slice = String(decoding: utf16[token.start..<token.end], as: UTF16.self)
                XCTAssertEqual(slice, token.text, "token \(token.i) of block \(block.index)")
            }
        }
    }

    func testGapsReconstructTheOriginalParagraph() throws {
        let document = try JSONDecoder().decode(FullDocument.self, from: fixture("document"))
        for block in document.content.blocks {
            var rebuilt = ""
            if let first = block.tokens.first, first.start > 0 {
                rebuilt += String(block.text.prefix(first.start))
            }
            for token in block.tokens {
                rebuilt += token.text
                rebuilt += block.gap(after: token)
            }
            XCTAssertEqual(rebuilt, block.text, "block \(block.index) did not round-trip")
        }
    }

    func testSentencesTileEveryBlockExactlyOnce() throws {
        let document = try JSONDecoder().decode(FullDocument.self, from: fixture("document"))
        var covered: [Int: Int] = [:]
        for sentence in document.content.sentences {
            XCTAssertGreaterThan(sentence.endToken, sentence.startToken)
            XCTAssertEqual(covered[sentence.blockIndex] ?? 0, sentence.startToken,
                           "sentences must tile block \(sentence.blockIndex) with no gaps")
            covered[sentence.blockIndex] = sentence.endToken
        }
        for block in document.content.blocks {
            XCTAssertEqual(covered[block.index], block.tokens.count,
                           "sentences must cover all of block \(block.index)")
        }
    }

    func testDocumentsCarryAnOwner() throws {
        // `ownerId` is optional in the Swift model so a library created before
        // accounts existed still parses. A payload from a current server must
        // always have one, or documents would silently show in the wrong place.
        let document = try JSONDecoder().decode(FullDocument.self, from: fixture("document"))
        XCTAssertNotNil(document.meta.ownerId)
    }

    func testDecodesFoldersAndAuthPayloads() throws {
        struct FolderResponse: Decodable { let folders: [FolderSummary]; let unfiled: Int }
        let folders = try JSONDecoder().decode(FolderResponse.self, from: fixture("folders"))
        XCTAssertGreaterThanOrEqual(folders.unfiled, 0)
        for folder in folders.folders {
            XCTAssertFalse(folder.name.isEmpty)
            XCTAssertGreaterThanOrEqual(folder.totalCount, folder.documentCount)
        }
    }

    func testDecodesTimelineAndLibraryAndVoices() throws {
        let timeline = try JSONDecoder().decode(Timeline.self, from: fixture("timeline"))
        XCTAssertFalse(timeline.chunks.isEmpty)
        XCTAssertFalse(timeline.words.isEmpty)

        struct LibraryResponse: Decodable { let documents: [LibraryEntry] }
        let library = try JSONDecoder().decode(LibraryResponse.self, from: fixture("library"))
        XCTAssertFalse(library.documents.isEmpty)

        struct VoicesResponse: Decodable { let voices: [Voice] }
        let voices = try JSONDecoder().decode(VoicesResponse.self, from: fixture("voices"))
        XCTAssertFalse(voices.voices.isEmpty)

        struct StateResponse: Decodable { let state: ReadingState }
        let state = try JSONDecoder().decode(StateResponse.self, from: fixture("state"))
        XCTAssertGreaterThanOrEqual(state.state.rev, 0)
        XCTAssertFalse(state.state.voiceId.isEmpty)
    }
}

final class TimelineIndexTests: XCTestCase {
    private func loadIndex() throws -> TimelineIndex {
        let bundle = Bundle(for: Self.self)
        func data(_ name: String) throws -> Data {
            guard let url = bundle.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
                    ?? bundle.url(forResource: name, withExtension: "json") else {
                throw CocoaError(.fileNoSuchFile)
            }
            return try Data(contentsOf: url)
        }
        let document = try JSONDecoder().decode(FullDocument.self, from: data("document"))
        let timeline = try JSONDecoder().decode(Timeline.self, from: data("timeline"))
        return TimelineIndex(timeline: timeline, content: document.content)
    }

    func testPositionAndTimeRoundTrip() throws {
        let index = try loadIndex()
        for word in index.timeline.words {
            XCTAssertEqual(index.timeMs(at: word.position), word.startMs)
            XCTAssertEqual(index.position(atMs: word.startMs), word.position)
        }
    }

    func testTimeLookupsClampAtBothEnds() throws {
        let index = try loadIndex()
        XCTAssertEqual(index.wordIndex(atMs: -10_000), 0)
        XCTAssertEqual(index.wordIndex(atMs: 9_999_999), index.timeline.words.count - 1)
    }

    func testActiveSentenceAlwaysContainsTheActiveWord() throws {
        let index = try loadIndex()
        for word in index.timeline.words {
            guard let span = index.activeSpan(atMs: word.startMs) else {
                return XCTFail("no span at \(word.startMs)")
            }
            let sentence = index.content.sentences[span.sentenceIndex]
            XCTAssertTrue(
                sentence.contains(tokenIndex: word.tokenIndex, inBlock: word.blockIndex),
                "word \(word.tokenIndex) of block \(word.blockIndex) fell outside its highlighted sentence"
            )
        }
    }

    func testWordProgressRunsFromZeroToOne() throws {
        let index = try loadIndex()
        guard let word = index.timeline.words.dropFirst(3).first else { return }
        XCTAssertEqual(index.activeSpan(atMs: word.startMs)?.wordProgress ?? -1, 0, accuracy: 0.02)
        let mid = word.startMs + (word.endMs - word.startMs) / 2
        let progress = index.activeSpan(atMs: mid)?.wordProgress ?? -1
        XCTAssertGreaterThan(progress, 0.4)
        XCTAssertLessThan(progress, 0.6)
    }

    func testProgressReachesExactlyOneOnTheLastWord() throws {
        let index = try loadIndex()
        XCTAssertEqual(index.progress(at: .start), 0, accuracy: 0.0001)
        guard let last = index.content.blocks.last else { return }
        let end = ReadingPosition(blockIndex: last.index, tokenIndex: last.tokens.count - 1)
        XCTAssertEqual(index.progress(at: end), 1, accuracy: 0.0001)
    }

    func testResumeDropsBackToTheStartOfTheSentence() throws {
        let index = try loadIndex()
        guard let sentence = index.content.sentences.first(where: { $0.endToken - $0.startToken > 3 }) else { return }
        let inside = ReadingPosition(blockIndex: sentence.blockIndex, tokenIndex: sentence.startToken + 2)
        XCTAssertEqual(
            index.resumeTarget(from: inside),
            ReadingPosition(blockIndex: sentence.blockIndex, tokenIndex: sentence.startToken)
        )
    }

    func testClampingKeepsPositionsInsideTheDocument() throws {
        let index = try loadIndex()
        XCTAssertEqual(index.clamp(ReadingPosition(blockIndex: -5, tokenIndex: -5)), .start)
        let clamped = index.clamp(ReadingPosition(blockIndex: 9_999, tokenIndex: 9_999))
        XCTAssertEqual(clamped.blockIndex, index.content.blocks.count - 1)
        XCTAssertEqual(clamped.tokenIndex, (index.content.blocks.last?.tokens.count ?? 1) - 1)
    }

    func testSentenceSeekingMovesAndClamps() throws {
        let index = try loadIndex()
        let forward = index.seek(from: .start, bySentences: 1)
        XCTAssertGreaterThan(forward, ReadingPosition.start)
        XCTAssertEqual(index.seek(from: .start, bySentences: -1), .start)

        let far = index.seek(from: .start, bySentences: 9_999)
        let lastSentence = index.content.sentences[index.content.sentences.count - 1]
        XCTAssertEqual(far.blockIndex, lastSentence.blockIndex)
    }

    func testPrefetchWindowWidensWithSpeed() throws {
        let index = try loadIndex()
        let slow = index.chunksToPrefetch(atMs: 0, speed: 1).count
        let fast = index.chunksToPrefetch(atMs: 0, speed: 4.5).count
        XCTAssertGreaterThanOrEqual(fast, slow)
    }
}

final class PositionPushGateTests: XCTestCase {
    func testFirstPositionAlwaysPushes() {
        var gate = PositionPushGate()
        XCTAssertTrue(gate.shouldPush(wordIndex: 0, now: Date(timeIntervalSince1970: 0)))
    }

    func testSmallMovementsWithinTheIntervalAreHeld() {
        var gate = PositionPushGate()
        let start = Date(timeIntervalSince1970: 0)
        _ = gate.shouldPush(wordIndex: 100, now: start)
        XCTAssertFalse(gate.shouldPush(wordIndex: 105, now: start.addingTimeInterval(1)))
    }

    func testLargeMovementPushesImmediately() {
        var gate = PositionPushGate()
        let start = Date(timeIntervalSince1970: 0)
        _ = gate.shouldPush(wordIndex: 100, now: start)
        XCTAssertTrue(gate.shouldPush(wordIndex: 140, now: start.addingTimeInterval(1)))
    }

    func testIntervalForcesAPushWithoutMovement() {
        var gate = PositionPushGate()
        let start = Date(timeIntervalSince1970: 0)
        _ = gate.shouldPush(wordIndex: 100, now: start)
        XCTAssertTrue(gate.shouldPush(wordIndex: 100, now: start.addingTimeInterval(11)))
    }

    func testForceOverridesEverything() {
        var gate = PositionPushGate()
        let start = Date(timeIntervalSince1970: 0)
        _ = gate.shouldPush(wordIndex: 100, now: start)
        XCTAssertTrue(gate.shouldPush(wordIndex: 100, now: start, force: true))
    }

    func testSeekingBackwardsCountsAsMovement() {
        var gate = PositionPushGate()
        let start = Date(timeIntervalSince1970: 0)
        _ = gate.shouldPush(wordIndex: 500, now: start)
        XCTAssertTrue(gate.shouldPush(wordIndex: 100, now: start.addingTimeInterval(1)))
    }
}
