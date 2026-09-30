import UIKit
import SwiftUI

//  The reading surface, as an attributed-text layout.
//
//  This is a UITextView rather than a stack of SwiftUI `Text` views for two
//  reasons the spec's requirements force:
//
//   - "Tap any paragraph or word to jump to that timestamp" needs per-character
//     hit testing, which SwiftUI's Text does not expose. TextKit does, exactly.
//   - Highlighting a word 30 times a second must not mean re-laying-out the
//     document. Mutating attributes on a text storage range is a repaint of the
//     affected line fragments only; rebuilding a SwiftUI view tree of 25,000
//     Text spans would not hold a frame rate.
//
//  On iOS 16 and later UITextView is backed by TextKit 2, which lays out only
//  the visible viewport, so a 50-page document opens without a stall.

/// Maps character offsets in the rendered string back to document positions.
struct TextLayoutIndex {
    struct Entry {
        let range: NSRange
        let blockIndex: Int
        let tokenIndex: Int
    }

    let entries: [Entry]
    /// Character range of each block, for paragraph-level taps and scrolling.
    let blockRanges: [Int: NSRange]
    /// Character range of each sentence, for the sentence tint.
    let sentenceRanges: [Int: NSRange]

    /// The word containing a character offset, or the nearest one before it.
    func position(atCharacter offset: Int) -> ReadingPosition? {
        var low = 0
        var high = entries.count - 1
        var best: Entry?
        while low <= high {
            let mid = (low + high) / 2
            let entry = entries[mid]
            if entry.range.location <= offset {
                best = entry
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        guard let best else { return nil }
        return ReadingPosition(blockIndex: best.blockIndex, tokenIndex: best.tokenIndex)
    }

    func range(ofBlock index: Int) -> NSRange? { blockRanges[index] }
    func range(ofSentence index: Int) -> NSRange? { sentenceRanges[index] }

    func range(ofWord position: ReadingPosition) -> NSRange? {
        entries.first {
            $0.blockIndex == position.blockIndex && $0.tokenIndex == position.tokenIndex
        }?.range
    }
}

/// A rendered document plus the index that maps it back to positions.
///
/// Held as a unit so the view can keep one value and rebuild it only when the
/// inputs actually change. `revision` identifies the build; the view compares
/// it instead of hashing the attributed string, which would walk every
/// character of a 50-page document on each update.
/// `@unchecked Sendable` because rendering happens off the main actor and the
/// result is handed back across that boundary. `NSAttributedString` is not
/// marked Sendable, but it is immutable, and nothing here mutates the value
/// after construction -- the live highlight mutates the text view's own
/// storage, never this.
struct RenderedDocument: @unchecked Sendable {
    let attributed: NSAttributedString
    let layout: TextLayoutIndex
    let revision: Int

    static let empty = RenderedDocument(
        attributed: NSAttributedString(string: ""),
        layout: TextLayoutIndex(entries: [], blockRanges: [:], sentenceRanges: [:]),
        revision: 0
    )
}

enum DocumentTextRenderer {
    /// Build the whole document as one attributed string, plus the index that
    /// maps it back to positions.
    static func render(
        content: DocumentContent,
        highlights: [Highlight],
        typeface: ReadingTypeface,
        fontSize: CGFloat,
        theme: ReadingTheme
    ) -> (NSAttributedString, TextLayoutIndex) {
        let output = NSMutableAttributedString()
        var entries: [TextLayoutIndex.Entry] = []
        var blockRanges: [Int: NSRange] = [:]
        var sentenceRanges: [Int: NSRange] = [:]

        let sentencesByBlock = Dictionary(grouping: content.sentences, by: \.blockIndex)
        let highlightsByBlock = Dictionary(grouping: highlights, by: \.blockIndex)

        for block in content.blocks {
            let blockStart = output.length
            let bodyFont = font(for: block, typeface: typeface, size: fontSize)

            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = fontSize * typeface.lineSpacingMultiplier
            paragraph.paragraphSpacing = fontSize * (block.type.isHeading ? 0.5 : 0.9)
            paragraph.paragraphSpacingBefore = block.type.isHeading ? fontSize * 0.8 : 0
            if block.type == .listItem { paragraph.headIndent = fontSize; paragraph.firstLineHeadIndent = fontSize }
            if block.type == .quote { paragraph.headIndent = fontSize; paragraph.firstLineHeadIndent = fontSize }

            let attributes: [NSAttributedString.Key: Any] = [
                .font: bodyFont,
                .foregroundColor: UIColor(theme.text),
                .paragraphStyle: paragraph,
            ]

            // Tokens are appended one at a time so each one's range is known
            // exactly; the original gap text between them is preserved so the
            // rendered paragraph reads as the source did.
            //
            // `blockEntries` mirrors this block's tokens by index, so the
            // sentence and highlight ranges below are O(1) lookups. Searching
            // the whole `entries` array for each of them instead would be
            // quadratic -- about 40 million comparisons on a 50-page document.
            var blockEntries: [TextLayoutIndex.Entry] = []
            blockEntries.reserveCapacity(block.tokens.count)

            for token in block.tokens {
                let tokenStart = output.length
                output.append(NSAttributedString(string: token.text, attributes: attributes))
                let entry = TextLayoutIndex.Entry(
                    range: NSRange(location: tokenStart, length: token.text.utf16.count),
                    blockIndex: block.index,
                    tokenIndex: token.i
                )
                entries.append(entry)
                blockEntries.append(entry)
                let gap = block.gap(after: token)
                if !gap.isEmpty {
                    output.append(NSAttributedString(string: gap, attributes: attributes))
                }
            }

            blockRanges[block.index] = NSRange(location: blockStart, length: output.length - blockStart)

            // Sentence ranges, measured from the token entries just appended.
            for sentence in sentencesByBlock[block.index] ?? [] {
                guard let first = blockEntries[safe: sentence.startToken],
                      let last = blockEntries[safe: sentence.endToken - 1] else { continue }
                sentenceRanges[sentence.index] = NSRange(
                    location: first.range.location,
                    length: NSMaxRange(last.range) - first.range.location
                )
            }

            // Persistent annotations: a wash plus an underline, so an annotated
            // word being spoken is still unmistakably the word being spoken.
            for highlight in highlightsByBlock[block.index] ?? [] {
                guard let first = blockEntries[safe: highlight.startToken],
                      let last = blockEntries[safe: highlight.endToken - 1] else { continue }
                let range = NSRange(
                    location: first.range.location,
                    length: NSMaxRange(last.range) - first.range.location
                )
                output.addAttributes([
                    .backgroundColor: UIColor(theme.accent.opacity(0.16)),
                    .underlineStyle: NSUnderlineStyle.thick.rawValue,
                    .underlineColor: UIColor(theme.accent.opacity(0.55)),
                ], range: range)
            }

            output.append(NSAttributedString(string: "\n", attributes: attributes))
        }

        return (output, TextLayoutIndex(entries: entries, blockRanges: blockRanges, sentenceRanges: sentenceRanges))
    }

    /// Rendering a long document is measured in tens of milliseconds, so it is
    /// done off the main actor and handed back as one value.
    static func renderDocument(
        content: DocumentContent,
        highlights: [Highlight],
        typeface: ReadingTypeface,
        fontSize: CGFloat,
        theme: ReadingTheme,
        revision: Int
    ) -> RenderedDocument {
        let (attributed, layout) = render(
            content: content, highlights: highlights,
            typeface: typeface, fontSize: fontSize, theme: theme
        )
        return RenderedDocument(attributed: attributed, layout: layout, revision: revision)
    }

    private static func font(for block: Block, typeface: ReadingTypeface, size: CGFloat) -> UIFont {
        let scale: CGFloat
        var weight: UIFont.Weight = .regular
        switch block.type {
        case .heading1: scale = 1.65; weight = .bold
        case .heading2: scale = 1.3;  weight = .bold
        case .heading3: scale = 1.1;  weight = .semibold
        case .code:     scale = 0.88
        default:        scale = 1
        }

        let pointSize = size * scale
        switch typeface {
        case .sans:
            return .systemFont(ofSize: pointSize, weight: weight)
        case .serif:
            let base = UIFont.systemFont(ofSize: pointSize, weight: weight)
            guard let descriptor = base.fontDescriptor.withDesign(.serif) else { return base }
            return UIFont(descriptor: descriptor, size: pointSize)
        case .dyslexic:
            // Falls back to the system face if the bundled font is missing,
            // rather than silently rendering in Times.
            return UIFont(name: "OpenDyslexic", size: pointSize)
                ?? .systemFont(ofSize: pointSize, weight: weight)
        }
    }
}


extension Array {
    /// Bounds-checked subscript: the server's token ranges are trusted but not
    /// assumed, so a malformed range skips rather than traps.
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
