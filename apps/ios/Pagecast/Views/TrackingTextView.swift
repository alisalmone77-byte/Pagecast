import SwiftUI
import UIKit

//  The SwiftUI bridge to the reading surface.
//
//  Highlighting mutates attributes on the existing text storage rather than
//  rebuilding the string. Only the two ranges that changed are touched, so a
//  word change repaints a line fragment instead of re-laying out the document.

struct TrackingTextView: UIViewRepresentable {
    let attributed: NSAttributedString
    let layout: TextLayoutIndex
    let theme: ReadingTheme
    /// The word currently being spoken, if any.
    let activePosition: ReadingPosition?
    let activeSentence: Int?
    let sentenceHighlight: Bool
    let autoScroll: Bool
    let onTapWord: (ReadingPosition) -> Void
    let onSelect: (ReadingPosition, ReadingPosition) -> Void

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.alwaysBounceVertical = true
        view.textContainerInset = UIEdgeInsets(top: 24, left: 20, bottom: 220, right: 20)
        view.textContainer.lineFragmentPadding = 0
        view.attributedText = attributed
        view.delegate = context.coordinator
        // A long document should not fight with the reader's finger.
        view.contentInsetAdjustmentBehavior = .automatic

        let tap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleTap(_:))
        )
        // Let selection and link gestures win; only a plain tap seeks.
        tap.cancelsTouchesInView = false
        view.addGestureRecognizer(tap)

        context.coordinator.textView = view
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self

        // Only replace the whole string when the content or styling changed;
        // a word change must never take this path.
        if coordinator.renderedRevision != attributed.hashValue {
            coordinator.renderedRevision = attributed.hashValue
            let offset = view.contentOffset
            view.attributedText = attributed
            view.contentOffset = offset
            coordinator.activeWordRange = nil
            coordinator.activeSentenceRange = nil
        }

        coordinator.apply(
            activePosition: activePosition,
            activeSentence: sentenceHighlight ? activeSentence : nil,
            layout: layout,
            theme: theme,
            autoScroll: autoScroll
        )
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: TrackingTextView
        weak var textView: UITextView?
        var renderedRevision: Int = 0
        var activeWordRange: NSRange?
        var activeSentenceRange: NSRange?
        private var lastScrolledBlock = -1

        init(parent: TrackingTextView) {
            self.parent = parent
            self.renderedRevision = parent.attributed.hashValue
        }

        /// Move the highlight, touching only what changed.
        func apply(
            activePosition: ReadingPosition?,
            activeSentence: Int?,
            layout: TextLayoutIndex,
            theme: ReadingTheme,
            autoScroll: Bool
        ) {
            guard let textView else { return }
            let storage = textView.textStorage
            let full = NSRange(location: 0, length: storage.length)

            let nextSentenceRange = activeSentence.flatMap { layout.range(ofSentence: $0) }
            if nextSentenceRange != activeSentenceRange {
                storage.beginEditing()
                if let previous = activeSentenceRange, NSIntersectionRange(previous, full).length > 0 {
                    storage.removeAttribute(.backgroundColor, range: previous)
                }
                if let next = nextSentenceRange, NSIntersectionRange(next, full).length > 0 {
                    storage.addAttribute(.backgroundColor, value: UIColor(theme.sentenceTint), range: next)
                }
                storage.endEditing()
                activeSentenceRange = nextSentenceRange
            }

            let nextWordRange = activePosition.flatMap { layout.range(ofWord: $0) }
            if nextWordRange != activeWordRange {
                storage.beginEditing()
                if let previous = activeWordRange, NSIntersectionRange(previous, full).length > 0 {
                    storage.removeAttribute(.backgroundColor, range: previous)
                    storage.addAttribute(.foregroundColor, value: UIColor(theme.text), range: previous)
                    // Restore the sentence tint the word pill painted over.
                    if let sentence = activeSentenceRange {
                        let overlap = NSIntersectionRange(previous, sentence)
                        if overlap.length > 0 {
                            storage.addAttribute(
                                .backgroundColor, value: UIColor(theme.sentenceTint), range: overlap
                            )
                        }
                    }
                }
                if let next = nextWordRange, NSIntersectionRange(next, full).length > 0 {
                    storage.addAttribute(.backgroundColor, value: UIColor(theme.wordBackground), range: next)
                    storage.addAttribute(.foregroundColor, value: UIColor(theme.wordForeground), range: next)
                }
                storage.endEditing()
                activeWordRange = nextWordRange

                if autoScroll, let next = nextWordRange, let position = activePosition {
                    // Scroll on block changes only. Following every word would
                    // make the page twitch continuously, which is precisely the
                    // visual fatigue this product exists to remove.
                    if position.blockIndex != lastScrolledBlock {
                        lastScrolledBlock = position.blockIndex
                        keepInComfortBand(range: next, in: textView)
                    }
                }
            }
        }

        /// Scroll only when the voice drifts out of a comfortable band, biased
        /// high so there is always upcoming text visible below it.
        private func keepInComfortBand(range: NSRange, in view: UITextView) {
            let rect = view.layoutManager.boundingRect(
                forGlyphRange: view.layoutManager.glyphRange(
                    forCharacterRange: range, actualCharacterRange: nil
                ),
                in: view.textContainer
            )
            let y = rect.minY + view.textContainerInset.top
            let height = view.bounds.height
            let relative = y - view.contentOffset.y
            guard relative < height * 0.22 || relative > height * 0.62 else { return }

            let target = max(0, min(y - height * 0.34, view.contentSize.height - height))
            view.setContentOffset(CGPoint(x: 0, y: target), animated: !UIAccessibility.isReduceMotionEnabled)
        }

        @objc func handleTap(_ gesture: UITapGestureRecognizer) {
            guard let view = textView else { return }
            // A tap that ends a selection is not a seek.
            if let selected = view.selectedTextRange, !selected.isEmpty { return }

            var point = gesture.location(in: view)
            point.x -= view.textContainerInset.left
            point.y -= view.textContainerInset.top

            let index = view.layoutManager.characterIndex(
                for: point,
                in: view.textContainer,
                fractionOfDistanceBetweenInsertionPoints: nil
            )
            guard index < view.textStorage.length,
                  let position = parent.layout.position(atCharacter: index) else { return }
            parent.onTapWord(position)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard let selected = textView.selectedTextRange, !selected.isEmpty else { return }
            let start = textView.offset(from: textView.beginningOfDocument, to: selected.start)
            let end = textView.offset(from: textView.beginningOfDocument, to: selected.end)
            guard let from = parent.layout.position(atCharacter: start),
                  let to = parent.layout.position(atCharacter: max(start, end - 1)) else { return }
            parent.onSelect(from, to)
        }
    }
}
