import Foundation

//  On-disk cache of synthesised audio chunks.
//
//  Offline listening is the point: a commute is exactly when someone wants this
//  app and exactly when the network is worst. Chunks are immutable once written
//  -- a given document, voice and chunk index always produces the same audio --
//  so they can be cached forever and only evicted for space.

actor AudioCache {
    static let shared = AudioCache()

    private let root: URL
    private let fileManager = FileManager.default
    /// Downloads in flight, so two callers asking for the same chunk share one.
    private var inFlight: [String: Task<URL, Error>] = [:]

    init(root: URL? = nil) {
        if let root {
            self.root = root
        } else {
            let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            self.root = caches.appendingPathComponent("PagecastAudio", isDirectory: true)
        }
        try? fileManager.createDirectory(at: self.root, withIntermediateDirectories: true)
    }

    private func localURL(documentId: String, voiceId: String, chunk: AudioChunk) -> URL {
        let ext = (chunk.url as NSString).pathExtension
        return root
            .appendingPathComponent(documentId, isDirectory: true)
            .appendingPathComponent(voiceId, isDirectory: true)
            .appendingPathComponent(String(format: "%04d.%@", chunk.index, ext.isEmpty ? "wav" : ext))
    }

    func cachedURL(documentId: String, voiceId: String, chunk: AudioChunk) -> URL? {
        let url = localURL(documentId: documentId, voiceId: voiceId, chunk: chunk)
        return fileManager.fileExists(atPath: url.path) ? url : nil
    }

    /// Return the local file for a chunk, downloading it if necessary.
    func fileURL(documentId: String, voiceId: String, chunk: AudioChunk) async throws -> URL {
        let destination = localURL(documentId: documentId, voiceId: voiceId, chunk: chunk)
        if fileManager.fileExists(atPath: destination.path) { return destination }

        let key = destination.path
        if let existing = inFlight[key] { return try await existing.value }

        let task = Task<URL, Error> {
            let data = try await APIClient.shared.downloadChunk(chunk.url)
            try fileManager.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            // Write to a temporary file then move it into place, so an
            // interrupted download can never leave a truncated chunk that
            // would play as a click and desynchronise the highlight.
            let temporary = destination.appendingPathExtension("partial")
            try data.write(to: temporary, options: .atomic)
            if fileManager.fileExists(atPath: destination.path) {
                try? fileManager.removeItem(at: destination)
            }
            try fileManager.moveItem(at: temporary, to: destination)
            return destination
        }

        inFlight[key] = task
        defer { inFlight[key] = nil }
        return try await task.value
    }

    /// Warm a window of chunks without blocking the caller.
    func prefetch(documentId: String, voiceId: String, chunks: [AudioChunk]) {
        for chunk in chunks where cachedURL(documentId: documentId, voiceId: voiceId, chunk: chunk) == nil {
            Task { _ = try? await fileURL(documentId: documentId, voiceId: voiceId, chunk: chunk) }
        }
    }

    /// Whether a whole document is available offline, for the download badge.
    func isFullyCached(documentId: String, voiceId: String, chunks: [AudioChunk]) -> Bool {
        !chunks.isEmpty && chunks.allSatisfy {
            cachedURL(documentId: documentId, voiceId: voiceId, chunk: $0) != nil
        }
    }

    func bytesUsed() -> Int64 {
        guard let enumerator = fileManager.enumerator(
            at: root, includingPropertiesForKeys: [.fileSizeKey], options: [.skipsHiddenFiles]
        ) else { return 0 }

        var total: Int64 = 0
        for case let url as URL in enumerator {
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            total += Int64(size)
        }
        return total
    }

    func evict(documentId: String) {
        try? fileManager.removeItem(at: root.appendingPathComponent(documentId, isDirectory: true))
    }

    func evictAll() {
        try? fileManager.removeItem(at: root)
        try? fileManager.createDirectory(at: root, withIntermediateDirectories: true)
    }
}
