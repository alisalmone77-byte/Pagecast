import SwiftUI
import VisionKit
import Vision

//  Screen 2: the camera scanner.
//
//  VNDocumentCameraViewController does the hard part -- live edge detection,
//  perspective correction, multi-page capture, shadow removal -- and then
//  Vision's text recogniser runs over the corrected images. Doing OCR on the
//  corrected page rather than the raw frame is what makes the accuracy usable
//  on a curved paperback held at an angle.

/// Carries values across the hop to the OCR task.
///
/// `UIImage` and SwiftUI's callbacks are not marked `Sendable`, but this is
/// safe by construction: the images are created here and never mutated, the
/// closures are only ever invoked back on the main actor, and nothing on this
/// side touches either again after the hop.
private struct ScanHandoff: @unchecked Sendable {
    let images: [UIImage]
    let onFinish: ([String]) -> Void
    let onError: (Error) -> Void
}

struct DocumentScanner: UIViewControllerRepresentable {
    /// One recognised string per captured page.
    let onFinish: ([String]) -> Void
    let onCancel: () -> Void
    let onError: (Error) -> Void

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        private let parent: DocumentScanner

        init(_ parent: DocumentScanner) { self.parent = parent }

        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFinishWith scan: VNDocumentCameraScan
        ) {
            // Snapshot the images before dismissing: the scan object does not
            // outlive its controller.
            let handoff = ScanHandoff(
                images: (0..<scan.pageCount).map { scan.imageOfPage(at: $0) },
                onFinish: parent.onFinish,
                onError: parent.onError
            )
            controller.dismiss(animated: true)

            // Recognition is seconds of work per page; running it on the main
            // thread would freeze the dismissal animation and the spinner.
            Task.detached(priority: .userInitiated) {
                do {
                    var pages: [String] = []
                    for image in handoff.images {
                        pages.append(try Self.recogniseText(in: image))
                    }
                    await MainActor.run { handoff.onFinish(pages) }
                } catch {
                    await MainActor.run { handoff.onError(error) }
                }
            }
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            controller.dismiss(animated: true)
            parent.onCancel()
        }

        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController, didFailWithError error: Error
        ) {
            controller.dismiss(animated: true)
            parent.onError(error)
        }

        /// Recognise text and reassemble it into reading order.
        ///
        /// Vision returns observations positioned in a normalised, bottom-left
        /// origin space with no notion of paragraphs. Lines are sorted top to
        /// bottom, then a blank line is inserted where the vertical gap between
        /// two lines exceeds the running line height -- which is where a
        /// paragraph break was on the page. That matters because the server
        /// splits blocks on blank lines, and a page that arrives as one
        /// undifferentiated wall of text loses every paragraph pause.
        static func recogniseText(in image: UIImage) throws -> String {
            guard let cgImage = image.cgImage else { return "" }

            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            request.revision = VNRecognizeTextRequestRevision3

            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
            try handler.perform([request])

            guard let observations = request.results, !observations.isEmpty else { return "" }

            struct Line {
                let text: String
                let top: CGFloat
                let height: CGFloat
                let left: CGFloat
            }

            let lines: [Line] = observations.compactMap { observation in
                guard let candidate = observation.topCandidates(1).first else { return nil }
                let box = observation.boundingBox
                // Vision's origin is bottom-left; flip so larger means lower.
                return Line(
                    text: candidate.string,
                    top: 1 - box.maxY,
                    height: box.height,
                    left: box.minX
                )
            }
            .sorted { $0.top < $1.top }

            guard !lines.isEmpty else { return "" }

            let medianHeight = lines.map(\.height).sorted()[lines.count / 2]
            let leftEdge = lines.map(\.left).sorted()[lines.count / 4]

            var paragraphs: [String] = []
            var buffer: [String] = []

            func flush() {
                let joined = buffer.joined(separator: " ").trimmingCharacters(in: .whitespaces)
                if !joined.isEmpty { paragraphs.append(joined) }
                buffer.removeAll()
            }

            for (offset, line) in lines.enumerated() {
                if offset > 0 {
                    let previous = lines[offset - 1]
                    let gap = line.top - (previous.top + previous.height)
                    let indented = line.left > leftEdge + medianHeight * 0.6
                    if gap > medianHeight * 0.85 || indented { flush() }
                }

                // Rejoin a word the printer split across the line break.
                if let last = buffer.last, last.hasSuffix("-") {
                    buffer[buffer.count - 1] = String(last.dropLast()) + line.text
                } else {
                    buffer.append(line.text)
                }
            }
            flush()

            return paragraphs.joined(separator: "\n\n")
        }
    }
}

/// Presents the scanner, then uploads the recognised pages.
struct ScannerFlow: View {
    let onComplete: (DocumentMeta) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var isWorking = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            if VNDocumentCameraViewController.isSupported {
                DocumentScanner(
                    onFinish: { pages in
                        let usable = pages.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                        guard !usable.isEmpty else {
                            errorMessage = "No text could be read from those pages. Try again with more light, or hold the camera square to the page."
                            return
                        }
                        Task { await upload(usable) }
                    },
                    onCancel: { dismiss() },
                    onError: { errorMessage = $0.localizedDescription }
                )
                .ignoresSafeArea()
            } else {
                ContentUnavailableView(
                    "Scanning is not available",
                    systemImage: "camera.slash",
                    description: Text("This device does not support document scanning. You can still add documents from a link or from the web app.")
                )
            }

            if isWorking {
                Color.black.opacity(0.55).ignoresSafeArea()
                VStack(spacing: 12) {
                    ProgressView().controlSize(.large).tint(.white)
                    Text("Reading the page…").foregroundStyle(.white)
                }
            }
        }
        .alert("Scan failed", isPresented: .constant(errorMessage != nil)) {
            Button("OK") { errorMessage = nil; dismiss() }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private func upload(_ pages: [String]) async {
        isWorking = true
        defer { isWorking = false }
        do {
            // Name it after the first line, which on a book page is usually the
            // chapter title or the running head.
            let title = pages.first?
                .split(separator: "\n")
                .first
                .map { String($0.prefix(70)) }
            let meta = try await APIClient.shared.ingest(scannedPages: pages, title: title)
            onComplete(meta)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
