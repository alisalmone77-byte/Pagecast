import Foundation

//  The document and playback model, mirroring packages/core/src/types.ts.
//
//  Kept as hand-written Swift rather than generated from the TypeScript so the
//  types can be value types with Swift's own naming and Codable conformance.
//  The wire format is the contract between them; `PagecastTests` asserts that
//  real API payloads decode into these types, which is what keeps the two
//  definitions from drifting apart.

struct Token: Codable, Hashable, Identifiable {
    let i: Int
    let text: String
    let start: Int
    let end: Int

    var id: Int { i }
}

enum BlockType: String, Codable {
    case heading1, heading2, heading3, paragraph, quote, listItem, code

    var isHeading: Bool {
        self == .heading1 || self == .heading2 || self == .heading3
    }
}

struct Block: Codable, Hashable, Identifiable {
    let index: Int
    let type: BlockType
    let text: String
    let tokens: [Token]

    var id: Int { index }

    /// The characters between `token` and the next one, so rendered text keeps
    /// the source's punctuation and spacing.
    ///
    /// The server's offsets are JavaScript string indices, which are UTF-16
    /// code units. Swift's `String.index(_:offsetBy:)` counts grapheme
    /// clusters, and the two agree only for plain ASCII -- one accented
    /// character or emoji earlier in the paragraph would shift every gap after
    /// it. `String.Index(utf16Offset:in:)` is the offset the server meant.
    func gap(after token: Token) -> String {
        let limit = text.utf16.count
        // Tokens are stored in order, so the next one is the next element.
        let next = tokens.indices.contains(token.i + 1) ? tokens[token.i + 1] : nil
        let nextStart = min(next?.start ?? limit, limit)
        guard token.end < nextStart, token.end >= 0 else { return "" }

        let lower = String.Index(utf16Offset: token.end, in: text)
        let upper = String.Index(utf16Offset: nextStart, in: text)
        guard lower < upper, upper <= text.endIndex else { return "" }
        return String(text[lower..<upper])
    }
}

struct Sentence: Codable, Hashable, Identifiable {
    let index: Int
    let blockIndex: Int
    let startToken: Int
    let endToken: Int

    var id: Int { index }

    func contains(tokenIndex: Int, inBlock block: Int) -> Bool {
        block == blockIndex && tokenIndex >= startToken && tokenIndex < endToken
    }
}

struct DocumentContent: Codable, Hashable {
    let blocks: [Block]
    let sentences: [Sentence]

    var wordCount: Int { blocks.reduce(0) { $0 + $1.tokens.count } }
}

/// Where a reader is, independent of voice and speaking rate.
///
/// This is the whole reason hand-off works: audio duration depends on the voice
/// and the speed, both of which differ between a Mac and a phone, so seconds do
/// not survive the trip. A word index does.
struct ReadingPosition: Codable, Hashable, Comparable {
    let blockIndex: Int
    let tokenIndex: Int

    static let start = ReadingPosition(blockIndex: 0, tokenIndex: 0)

    static func < (lhs: ReadingPosition, rhs: ReadingPosition) -> Bool {
        lhs.blockIndex == rhs.blockIndex
            ? lhs.tokenIndex < rhs.tokenIndex
            : lhs.blockIndex < rhs.blockIndex
    }
}

enum SourceKind: String, Codable {
    case pdf, epub, docx, txt, url, scan, paste

    var label: String {
        switch self {
        case .pdf: return "PDF"
        case .epub: return "EPUB"
        case .docx: return "DOCX"
        case .url: return "Article"
        case .scan: return "Scan"
        case .paste, .txt: return "Text"
        }
    }

    var systemImage: String {
        switch self {
        case .pdf: return "doc.richtext"
        case .epub: return "book"
        case .docx: return "doc.text"
        case .url: return "safari"
        case .scan: return "camera.viewfinder"
        case .paste, .txt: return "text.alignleft"
        }
    }
}

enum AudioState: String, Codable {
    case none, pending, partial, ready, failed
}

struct DocumentMeta: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    let author: String?
    let sourceKind: SourceKind
    let sourceRef: String?
    let createdAt: String
    let updatedAt: String
    let wordCount: Int
    let blockCount: Int
    let audioState: AudioState
    let folderId: String?
    let bookmarked: Bool?
}

// MARK: - Audio

struct AudioChunk: Codable, Hashable, Identifiable {
    let index: Int
    let startMs: Int
    let durationMs: Int
    let url: String
    let startSentence: Int
    let endSentence: Int

    var id: Int { index }
    var endMs: Int { startMs + durationMs }
}

struct WordTiming: Codable, Hashable {
    let blockIndex: Int
    let tokenIndex: Int
    let startMs: Int
    let endMs: Int

    var position: ReadingPosition {
        ReadingPosition(blockIndex: blockIndex, tokenIndex: tokenIndex)
    }
}

struct Timeline: Codable, Hashable {
    let voiceId: String
    let durationMs: Int
    let chunks: [AudioChunk]
    let words: [WordTiming]
    let sentenceStarts: [Int]
    let precise: Bool
}

struct Voice: Codable, Hashable, Identifiable {
    let id: String
    let label: String
    let accent: String
    let gender: String
    let provider: String
    let baseWpm: Int
}

// MARK: - Reading state

struct ReadingState: Codable, Hashable {
    let documentId: String
    let position: ReadingPosition
    let progress: Double
    let speed: Double
    let voiceId: String
    let rev: Int
    let updatedAt: String
    let deviceId: String
}

struct Highlight: Codable, Hashable, Identifiable {
    let id: String
    let documentId: String
    let blockIndex: Int
    let startToken: Int
    let endToken: Int
    let note: String?
    let color: String?
    let createdAt: String
}

/// What the reader view needs to paint one frame.
struct ActiveSpan: Equatable {
    let wordIndex: Int
    let sentenceIndex: Int
    let position: ReadingPosition
    /// 0...1 through the current word, for the pill animation.
    let wordProgress: Double
}
