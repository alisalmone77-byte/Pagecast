import Foundation

//  Timeline lookups, mirroring packages/core/src/playback.ts and position.ts.
//
//  These run on every display-link tick, so both directions are binary searches
//  over the pre-sorted `words` array. On a 50-page document that is a handful
//  of comparisons per frame instead of a linear scan of 25,000 entries.

struct TimelineIndex {
    let timeline: Timeline
    let content: DocumentContent

    /// Running word count at the start of each block; the last entry is the total.
    private let blockOffsets: [Int]

    init(timeline: Timeline, content: DocumentContent) {
        self.timeline = timeline
        self.content = content

        var offsets: [Int] = [0]
        var running = 0
        for block in content.blocks {
            running += block.tokens.count
            offsets.append(running)
        }
        self.blockOffsets = offsets
    }

    var totalWords: Int { blockOffsets.last ?? 0 }
    var durationMs: Int { timeline.durationMs }

    // MARK: - Time to position

    /// Index into `timeline.words` of the word being spoken at `ms`.
    func wordIndex(atMs ms: Int) -> Int {
        let words = timeline.words
        guard let first = words.first else { return -1 }
        if ms <= first.startMs { return 0 }

        var low = 0
        var high = words.count - 1
        var best = 0
        while low <= high {
            let mid = (low + high) / 2
            if words[mid].startMs <= ms {
                best = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return best
    }

    func position(atMs ms: Int) -> ReadingPosition {
        let index = wordIndex(atMs: ms)
        guard index >= 0, index < timeline.words.count else { return .start }
        return timeline.words[index].position
    }

    /// Everything the reader view needs for one frame.
    func activeSpan(atMs ms: Int) -> ActiveSpan? {
        let index = wordIndex(atMs: ms)
        guard index >= 0, index < timeline.words.count else { return nil }
        let word = timeline.words[index]
        let span = max(1, word.endMs - word.startMs)
        let progress = min(1, max(0, Double(ms - word.startMs) / Double(span)))
        return ActiveSpan(
            wordIndex: index,
            sentenceIndex: sentenceIndex(forWordIndex: index),
            position: word.position,
            wordProgress: progress
        )
    }

    func sentenceIndex(forWordIndex wordIndex: Int) -> Int {
        let starts = timeline.sentenceStarts
        guard !starts.isEmpty else { return -1 }

        var low = 0
        var high = starts.count - 1
        var best = 0
        while low <= high {
            let mid = (low + high) / 2
            if starts[mid] <= wordIndex {
                best = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return best
    }

    // MARK: - Position to time

    func timeMs(at position: ReadingPosition) -> Int {
        let words = timeline.words
        guard !words.isEmpty else { return 0 }

        var low = 0
        var high = words.count - 1
        var best = -1
        while low <= high {
            let mid = (low + high) / 2
            if words[mid].position < position {
                low = mid + 1
            } else {
                best = mid
                high = mid - 1
            }
        }
        return best == -1 ? timeline.durationMs : words[best].startMs
    }

    // MARK: - Positions

    func clamp(_ position: ReadingPosition) -> ReadingPosition {
        guard !content.blocks.isEmpty else { return .start }
        let blockIndex = min(max(0, position.blockIndex), content.blocks.count - 1)
        let block = content.blocks[blockIndex]
        let tokenIndex = min(max(0, position.tokenIndex), max(0, block.tokens.count - 1))
        return ReadingPosition(blockIndex: blockIndex, tokenIndex: tokenIndex)
    }

    func globalWordIndex(of position: ReadingPosition) -> Int {
        let clamped = clamp(position)
        guard clamped.blockIndex < blockOffsets.count else { return 0 }
        return blockOffsets[clamped.blockIndex] + clamped.tokenIndex
    }

    /// Fraction read, 0...1. The denominator is the number of gaps between
    /// words so the last word reads exactly 1 and a finished document leaves
    /// the "continue listening" shelf.
    func progress(at position: ReadingPosition) -> Double {
        guard totalWords > 1 else { return 0 }
        return min(1, max(0, Double(globalWordIndex(of: position)) / Double(totalWords - 1)))
    }

    func sentence(containing position: ReadingPosition) -> Sentence? {
        let clamped = clamp(position)
        var low = 0
        var high = content.sentences.count - 1
        var best: Sentence?
        while low <= high {
            let mid = (low + high) / 2
            let candidate = content.sentences[mid]
            if candidate.blockIndex < clamped.blockIndex
                || (candidate.blockIndex == clamped.blockIndex && candidate.startToken <= clamped.tokenIndex) {
                best = candidate
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return best
    }

    /// Where playback should start when resuming.
    ///
    /// Dropping back to the start of the sentence costs a couple of seconds and
    /// restores the context a listener lost when they stopped, which matters
    /// more for comprehension than resuming on the exact syllable.
    func resumeTarget(from position: ReadingPosition) -> ReadingPosition {
        guard let sentence = sentence(containing: position) else { return clamp(position) }
        return ReadingPosition(blockIndex: sentence.blockIndex, tokenIndex: sentence.startToken)
    }

    /// First word of the sentence `delta` away, for swipe-to-skip gestures.
    func seek(from position: ReadingPosition, bySentences delta: Int) -> ReadingPosition {
        guard let current = sentence(containing: position) else { return clamp(position) }
        let target = min(content.sentences.count - 1, max(0, current.index + delta))
        guard target >= 0, target < content.sentences.count else { return clamp(position) }
        let sentence = content.sentences[target]
        return ReadingPosition(blockIndex: sentence.blockIndex, tokenIndex: sentence.startToken)
    }

    /// Chunks worth having on disk at `ms`. The lookahead widens with speed,
    /// since at 4x a chunk is consumed four times faster.
    func chunksToPrefetch(atMs ms: Int, speed: Double, lookaheadMs: Int = 45_000) -> [AudioChunk] {
        let horizon = ms + Int(Double(lookaheadMs) * max(1, speed))
        return timeline.chunks.filter { $0.endMs >= ms && $0.startMs <= horizon }
    }
}
