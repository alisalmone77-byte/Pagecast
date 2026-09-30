import AVFoundation
import Combine
import Foundation
import MediaPlayer

//  Chunked playback on AVQueuePlayer.
//
//  AVQueuePlayer is the right primitive here rather than AVAudioEngine: it
//  gives gapless transitions between chunks, background playback, route
//  changes, interruptions and the Now Playing controls essentially for free,
//  and this app never needs to mix or process audio -- only to play a sequence
//  of files at a variable rate and know exactly where it is.
//
//  Position is the sum of the durations of the chunks already played plus the
//  current item's own time, queried on demand from a CADisplayLink rather than
//  polled with a periodic observer, so the highlight is resolved for the frame
//  that is about to be drawn.

@MainActor
final class PlaybackEngine: NSObject, ObservableObject {
    enum Status: Equatable { case idle, loading, playing, paused, ended, failed(String) }

    @Published private(set) var status: Status = .idle
    @Published private(set) var mediaMs: Int = 0
    @Published private(set) var durationMs: Int = 0
    @Published private(set) var speed: Double = 1
    @Published private(set) var isBuffering = false

    /// Emits whenever the spoken word changes, for highlighting and sync.
    let activeSpan = PassthroughSubject<ActiveSpan, Never>()

    private var player: AVQueuePlayer?
    private var index: TimelineIndex?
    private var documentId: String = ""
    private var voiceId: String = ""
    private var title: String = ""

    /// Chunk index of each queued item, so position can be reconstructed.
    private var queuedChunks: [ObjectIdentifier: AudioChunk] = [:]
    private var displayLink: CADisplayLink?
    private var lastWordIndex = -1
    /// The exact playhead at the last tick, before quantising for publication.
    private var lastTickMs = 0

    var isPlaying: Bool { status == .playing }

    // MARK: - Session

    override init() {
        super.init()
        configureSession()
        configureRemoteCommands()
    }

    /// Background audio and the lock screen need an active playback session.
    private func configureSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            // .spokenAudio is the correct mode for this content: the system
            // ducks other audio appropriately and honours the user's
            // "speech" preferences.
            try session.setCategory(.playback, mode: .spokenAudio, policy: .longFormAudio)
            try session.setActive(true)
        } catch {
            status = .failed("Audio could not start: \(error.localizedDescription)")
        }
    }

    // MARK: - Loading

    func load(documentId: String, title: String, voiceId: String,
              index: TimelineIndex, startAtMs: Int, speed: Double) {
        stopDisplayLink()
        player?.pause()
        player = nil
        queuedChunks.removeAll()
        lastWordIndex = -1

        self.documentId = documentId
        self.title = title
        self.voiceId = voiceId
        self.index = index
        self.speed = speed
        self.durationMs = index.durationMs
        self.mediaMs = min(max(0, startAtMs), index.durationMs)
        self.status = index.timeline.chunks.isEmpty ? .loading : .paused

        updateNowPlaying()
    }

    /// Replace the timeline while a long document is still synthesising,
    /// without interrupting what is already playing.
    func updateIndex(_ next: TimelineIndex) {
        let wasPlaying = isPlaying
        let position = mediaMs
        index = next
        durationMs = next.durationMs
        if wasPlaying {
            Task { await seek(toMs: position, resume: true) }
        }
        updateNowPlaying()
    }

    // MARK: - Transport

    func play() async {
        guard let index, !index.timeline.chunks.isEmpty else { return }
        if mediaMs >= index.durationMs { mediaMs = 0 }
        await rebuildQueue(fromMs: mediaMs)
        player?.play()
        player?.rate = Float(speed)
        status = .playing
        startDisplayLink()
        updateNowPlaying()
    }

    func pause() {
        player?.pause()
        status = .paused
        stopDisplayLink()
        updateNowPlaying()
    }

    func toggle() async {
        if isPlaying { pause() } else { await play() }
    }

    func seek(toMs target: Int, resume: Bool? = nil) async {
        guard let index else { return }
        let shouldResume = resume ?? isPlaying
        let clamped = min(max(0, target), index.durationMs)
        mediaMs = clamped
        lastWordIndex = -1

        await rebuildQueue(fromMs: clamped)
        if shouldResume {
            player?.play()
            player?.rate = Float(speed)
            status = .playing
            startDisplayLink()
        } else {
            status = .paused
        }
        updateNowPlaying()
        emitSpan()
    }

    func seek(to position: ReadingPosition) async {
        guard let index else { return }
        await seek(toMs: index.timeMs(at: position))
    }

    /// Fifteen seconds of *media* time, whatever the rate -- the behaviour
    /// every podcast player has trained people to expect.
    func skip(seconds: Int) async {
        await seek(toMs: mediaMs + seconds * 1000)
    }

    func setSpeed(_ next: Double) {
        speed = min(4.5, max(0.5, (next * 10).rounded() / 10))
        if isPlaying { player?.rate = Float(speed) }
        updateNowPlaying()
    }

    // MARK: - Queue

    /// Build the player queue starting at `fromMs`.
    ///
    /// Only chunks already on disk are queued; the rest are fetched in the
    /// background and picked up on the next rebuild. That way playback starts
    /// immediately on a cached document and degrades to buffering rather than
    /// blocking on a slow connection.
    private func rebuildQueue(fromMs: Int) async {
        guard let index else { return }

        let remaining = index.timeline.chunks.filter { $0.endMs > fromMs }
        guard let first = remaining.first else {
            status = .ended
            return
        }

        isBuffering = true
        var items: [AVPlayerItem] = []
        var mapping: [ObjectIdentifier: AudioChunk] = [:]

        // The first chunk must be present to start at all.
        guard let firstURL = try? await AudioCache.shared.fileURL(
            documentId: documentId, voiceId: voiceId, chunk: first
        ) else {
            isBuffering = true
            status = .loading
            return
        }
        let firstItem = AVPlayerItem(url: firstURL)
        items.append(firstItem)
        mapping[ObjectIdentifier(firstItem)] = first

        // Queue whatever else is already cached, in order, stopping at the
        // first gap so chunks never play out of sequence.
        for chunk in remaining.dropFirst() {
            guard let url = await AudioCache.shared.cachedURL(
                documentId: documentId, voiceId: voiceId, chunk: chunk
            ) else { break }
            let item = AVPlayerItem(url: url)
            items.append(item)
            mapping[ObjectIdentifier(item)] = chunk
        }

        let queue = AVQueuePlayer(items: items)
        queue.automaticallyWaitsToMinimizeStalling = false
        player = queue
        queuedChunks = mapping
        isBuffering = false

        // Start partway into the first chunk when seeking into its middle.
        let offsetMs = max(0, fromMs - first.startMs)
        if offsetMs > 0 {
            _ = await firstItem.seek(to: CMTime(value: CMTimeValue(offsetMs), timescale: 1000))
        }

        NotificationCenter.default.removeObserver(self, name: .AVPlayerItemDidPlayToEndTime, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(itemFinished(_:)),
            name: .AVPlayerItemDidPlayToEndTime, object: nil
        )

        // Keep the rest of the document arriving ahead of the playhead.
        await AudioCache.shared.prefetch(
            documentId: documentId, voiceId: voiceId,
            chunks: index.chunksToPrefetch(atMs: fromMs, speed: speed)
        )
    }

    @objc private nonisolated func itemFinished(_ note: Notification) {
        Task { @MainActor in
            guard let index, let player else { return }
            // The queue drained but the document has not ended: the next chunk
            // had not been downloaded when the queue was built. Rebuild from
            // where we are, which will pick it up if it has arrived since.
            if player.items().isEmpty && mediaMs < index.durationMs - 200 {
                status = .loading
                await rebuildQueue(fromMs: mediaMs)
                if status != .loading {
                    player.play()
                    player.rate = Float(speed)
                    status = .playing
                }
            } else if player.items().isEmpty {
                status = .ended
                stopDisplayLink()
                updateNowPlaying()
            }
        }
    }

    // MARK: - Clock

    private func startDisplayLink() {
        stopDisplayLink()
        let link = CADisplayLink(target: self, selector: #selector(tick))
        // The highlight only needs to be right to within a frame or two, and
        // 30fps halves the wake-ups on a device that may be in a pocket.
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30, preferred: 30)
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    private func stopDisplayLink() {
        displayLink?.invalidate()
        displayLink = nil
    }

    @objc private func tick() {
        guard let player, let current = player.currentItem,
              let chunk = queuedChunks[ObjectIdentifier(current)] else { return }
        let within = CMTimeGetSeconds(current.currentTime())
        guard within.isFinite else { return }

        let position = chunk.startMs + Int(within * 1000)

        // The highlight needs every tick, so it is driven from the subject
        // rather than from `mediaMs`. The published position only needs to be
        // fine enough for a clock and a scrubber, and publishing it 30 times a
        // second would re-render the dock on every frame for no visible gain.
        if position / 100 != mediaMs / 100 { mediaMs = position }
        lastTickMs = position
        emitSpan(atMs: position)
    }

    private func emitSpan(atMs ms: Int? = nil) {
        guard let index, let span = index.activeSpan(atMs: ms ?? mediaMs) else { return }
        guard span.wordIndex != lastWordIndex else { return }
        lastWordIndex = span.wordIndex
        activeSpan.send(span)
    }

    // MARK: - Now Playing and remote commands

    private func configureRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in await self?.play() }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.pause() }
            return .success
        }
        center.skipForwardCommand.preferredIntervals = [15]
        center.skipForwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in await self?.skip(seconds: 15) }
            return .success
        }
        center.skipBackwardCommand.preferredIntervals = [15]
        center.skipBackwardCommand.addTarget { [weak self] _ in
            Task { @MainActor in await self?.skip(seconds: -15) }
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            Task { @MainActor in await self?.seek(toMs: Int(event.positionTime * 1000)) }
            return .success
        }
    }

    private func updateNowPlaying() {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyPlaybackDuration: Double(durationMs) / 1000,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: Double(mediaMs) / 1000,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? speed : 0,
            MPNowPlayingInfoPropertyIsLiveStream: false,
        ]
        info[MPMediaItemPropertyAlbumTitle] = "Pagecast"
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
