import Combine
import SwiftUI

//  Screen 3: the active reader, with Screen 4 (the audio sheet) presented over it.

@MainActor
final class ReaderModel: ObservableObject {
    @Published private(set) var document: FullDocument?
    @Published private(set) var index: TimelineIndex?
    @Published private(set) var voices: [Voice] = []
    @Published private(set) var synthesis: (done: Int, total: Int)?
    @Published private(set) var errorMessage: String?
    @Published private(set) var isLoading = true
    @Published private(set) var progress: Double = 0

    @Published var activeSpan: ActiveSpan?
    /// Another device moved ahead while this one was open.
    @Published var handoff: ReadingState?

    let engine = PlaybackEngine()

    private let meta: DocumentMeta
    private var revision = 0
    private var position: ReadingPosition = .start
    private var gate = PositionPushGate()
    private var cancellables: Set<AnyCancellable> = []
    private var pollTask: Task<Void, Never>?
    private var voiceId = ""

    init(meta: DocumentMeta) {
        self.meta = meta

        engine.activeSpan
            .receive(on: RunLoop.main)
            .sink { [weak self] span in self?.handle(span) }
            .store(in: &cancellables)

        SyncClient.shared.$incoming
            .compactMap { $0 }
            .filter { [meta] in $0.documentId == meta.id }
            .receive(on: RunLoop.main)
            .sink { [weak self] state in
                // Do not yank the page from under someone who is reading: offer it.
                self?.revision = max(self?.revision ?? 0, state.rev)
                self?.handoff = state
            }
            .store(in: &cancellables)
    }

    func load(settings: ReaderSettings) async {
        isLoading = true
        do {
            let voices = try await APIClient.shared.voices()
            self.voices = voices
            voiceId = voices.first(where: { $0.id == settings.voiceId })?.id ?? voices.first?.id ?? ""

            let document = try await APIClient.shared.document(meta.id)
            self.document = document
            revision = document.state.rev
            progress = document.state.progress
            if !document.state.voiceId.isEmpty,
               voices.contains(where: { $0.id == document.state.voiceId }) {
                voiceId = document.state.voiceId
            }

            SyncClient.shared.connect()
            SyncClient.shared.subscribe(meta.id)

            isLoading = false
            await startSynthesis(settings: settings, resumeFrom: document.state.position)
        } catch let error as APIError where error.isUnauthorized {
            await SessionStore.shared.signOutLocally()
            isLoading = false
        } catch {
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }

    /// Kick off synthesis and keep pulling the timeline as it grows, so a long
    /// document is playable from its first chunk.
    private func startSynthesis(settings: ReaderSettings, resumeFrom: ReadingPosition) async {
        guard let document else { return }
        pollTask?.cancel()

        pollTask = Task { [weak self] in
            guard let self else { return }
            do {
                var response = try await APIClient.shared.startSynthesis(self.meta.id, voiceId: self.voiceId)
                while !Task.isCancelled {
                    if let error = response.error {
                        await MainActor.run { self.errorMessage = error }
                        return
                    }
                    if let timeline = response.timeline, !timeline.chunks.isEmpty {
                        await MainActor.run {
                            self.adopt(timeline: timeline, content: document.content,
                                       settings: settings, resumeFrom: resumeFrom)
                        }
                    }
                    let done = response.done ?? 0
                    let total = response.total ?? 0
                    await MainActor.run {
                        self.synthesis = (total > 0 && done < total) ? (done, total) : nil
                    }
                    if total > 0 && done >= total { return }

                    try await Task.sleep(nanoseconds: 1_200_000_000)
                    response = try await APIClient.shared.timeline(self.meta.id, voiceId: self.voiceId)
                }
            } catch is CancellationError {
                return
            } catch {
                await MainActor.run { self.errorMessage = error.localizedDescription }
            }
        }
    }

    private func adopt(timeline: Timeline, content: DocumentContent,
                       settings: ReaderSettings, resumeFrom: ReadingPosition) {
        let next = TimelineIndex(timeline: timeline, content: content)
        if let existing = index, existing.timeline.voiceId == timeline.voiceId {
            // The timeline grew: keep playing, just extend it.
            guard existing.timeline.chunks.count != timeline.chunks.count else { return }
            index = next
            engine.updateIndex(next)
            return
        }

        index = next
        // Resuming at the start of the sentence restores the context a
        // listener lost when they stopped.
        let resume = next.resumeTarget(from: resumeFrom)
        position = resume
        progress = next.progress(at: resume)
        engine.load(
            documentId: meta.id, title: meta.title, voiceId: timeline.voiceId,
            index: next, startAtMs: next.timeMs(at: resume), speed: settings.speed
        )
    }

    // MARK: - Transport

    func play() async { await engine.play(); push(force: true) }
    func pause() { engine.pause(); push(force: true) }
    func toggle() async { await engine.toggle(); push(force: true) }

    func seek(toMs ms: Int) async {
        await engine.seek(toMs: ms)
        if let index { position = index.position(atMs: ms) }
        push(force: true)
    }

    func seek(to target: ReadingPosition) async {
        guard let index else { return }
        position = target
        await engine.seek(toMs: index.timeMs(at: target))
        push(force: true)
    }

    func skip(seconds: Int) async {
        await engine.skip(seconds: seconds)
        push(force: true)
    }

    /// Swipe gesture: jump whole sentences.
    func skipSentence(_ delta: Int) async {
        guard let index else { return }
        await seek(to: index.seek(from: position, bySentences: delta))
    }

    func setSpeed(_ speed: Double, settings: ReaderSettings) {
        engine.setSpeed(speed)
        settings.speed = engine.speed
        push(force: true)
    }

    func setVoice(_ id: String, settings: ReaderSettings) async {
        guard id != voiceId, let document else { return }
        voiceId = id
        settings.voiceId = id
        index = nil
        // The new voice has its own timeline; playback resumes at the same
        // word, which is exactly why positions are words and not seconds.
        await startSynthesis(settings: settings, resumeFrom: position)
    }

    func acceptHandoff() async {
        guard let handoff, let index else { return }
        await seek(to: index.resumeTarget(from: handoff.position))
        self.handoff = nil
    }

    func addHighlight(from: ReadingPosition, to: ReadingPosition, note: String?) async {
        guard let document, from.blockIndex == to.blockIndex else { return }
        do {
            _ = try await APIClient.shared.addHighlight(
                document.meta.id, blockIndex: from.blockIndex,
                startToken: min(from.tokenIndex, to.tokenIndex),
                endToken: max(from.tokenIndex, to.tokenIndex) + 1,
                note: note
            )
            // Re-read so the rendered text picks the annotation up.
            self.document = try await APIClient.shared.document(document.meta.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func teardown() {
        pollTask?.cancel()
        SyncClient.shared.unsubscribe(meta.id)
        push(force: true)
    }

    // MARK: - Position reporting

    private func handle(_ span: ActiveSpan) {
        activeSpan = span
        position = span.position
        if let index { progress = index.progress(at: span.position) }
        push(force: false)
    }

    private func push(force: Bool) {
        guard let index else { return }
        let wordIndex = index.globalWordIndex(of: position)
        guard gate.shouldPush(wordIndex: wordIndex, force: force) else { return }

        let snapshot = (id: meta.id, position: position, speed: engine.speed, voiceId: voiceId, rev: revision)
        Task { [weak self] in
            guard let state = try? await APIClient.shared.putState(
                snapshot.id, position: snapshot.position, speed: snapshot.speed,
                voiceId: snapshot.voiceId, rev: snapshot.rev
            ) else { return }  // Offline: the next push carries a newer position anyway.
            await MainActor.run {
                self?.revision = state.rev
                self?.progress = state.progress
            }
        }
    }
}

struct ReaderView: View {
    let meta: DocumentMeta

    @EnvironmentObject private var settings: ReaderSettings
    @StateObject private var model: ReaderModel
    /// Built once per document/appearance change, never per frame.
    @State private var rendered: RenderedDocument = .empty
    @State private var renderRevision = 0
    @State private var showingAudioSheet = false
    @State private var showingSettings = false
    @State private var pendingSelection: (ReadingPosition, ReadingPosition)?
    @Environment(\.dismiss) private var dismiss

    init(meta: DocumentMeta) {
        self.meta = meta
        _model = StateObject(wrappedValue: ReaderModel(meta: meta))
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            settings.theme.background.ignoresSafeArea()

            if model.document != nil {
                TrackingTextView(
                    attributed: rendered.attributed,
                    revision: rendered.revision,
                    layout: rendered.layout,
                    theme: settings.theme,
                    activePosition: model.activeSpan?.position,
                    activeSentence: model.activeSpan?.sentenceIndex,
                    sentenceHighlight: settings.sentenceHighlight,
                    autoScroll: settings.autoScroll,
                    onTapWord: { position in
                        Task {
                            await model.seek(to: position)
                            if !model.engine.isPlaying { await model.play() }
                        }
                    },
                    onSelect: { from, to in pendingSelection = (from, to) }
                )
                .ignoresSafeArea(edges: .bottom)
                // Swipe left/right to move by section.
                .gesture(
                    DragGesture(minimumDistance: 60)
                        .onEnded { value in
                            guard abs(value.translation.width) > abs(value.translation.height) * 2 else { return }
                            Task { await model.skipSentence(value.translation.width < 0 ? 1 : -1) }
                        }
                )
            } else if model.isLoading {
                ProgressView().controlSize(.large)
            } else if let message = model.errorMessage {
                ContentUnavailableView("Could not open", systemImage: "exclamationmark.triangle", description: Text(message))
            }

            VStack(spacing: 0) {
                if let handoff = model.handoff {
                    HandoffBanner(state: handoff, theme: settings.theme) {
                        Task { await model.acceptHandoff() }
                    } onDismiss: {
                        model.handoff = nil
                    }
                }
                MiniPlayer(model: model, engine: model.engine, theme: settings.theme) {
                    showingAudioSheet = true
                }
            }
        }
        .navigationTitle(meta.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingSettings = true } label: { Image(systemName: "textformat.size") }
            }
        }
        .sheet(isPresented: $showingAudioSheet) {
            AudioSheet(model: model, engine: model.engine).environmentObject(settings)
        }
        .sheet(isPresented: $showingSettings) {
            ReadingSettingsSheet().environmentObject(settings)
                .presentationDetents([.medium])
        }
        .confirmationDialog("Selection", isPresented: .constant(pendingSelection != nil)) {
            Button("Highlight") {
                if let (from, to) = pendingSelection {
                    Task { await model.addHighlight(from: from, to: to, note: nil) }
                }
                pendingSelection = nil
            }
            Button("Play from here") {
                if let (from, _) = pendingSelection {
                    Task { await model.seek(to: from); await model.play() }
                }
                pendingSelection = nil
            }
            Button("Cancel", role: .cancel) { pendingSelection = nil }
        }
        .task { await model.load(settings: settings) }
        // Re-render only when something that affects the text changes. The
        // active word is deliberately not in this key: it moves several times a
        // second and is applied by mutating attributes, not by rebuilding.
        .task(id: RenderKey(
            documentId: model.document?.meta.id ?? "",
            highlights: model.document?.highlights.count ?? 0,
            typeface: settings.typeface,
            fontSize: settings.fontSize,
            theme: settings.theme
        )) {
            guard let document = model.document else { return }
            renderRevision += 1
            let revision = renderRevision
            let typeface = settings.typeface
            let fontSize = settings.fontSize
            let theme = settings.theme
            let content = document.content
            let highlights = document.highlights

            // Tens of milliseconds on a long document: off the main actor so
            // opening a book does not drop frames.
            let next = await Task.detached(priority: .userInitiated) {
                DocumentTextRenderer.renderDocument(
                    content: content, highlights: highlights,
                    typeface: typeface, fontSize: fontSize,
                    theme: theme, revision: revision
                )
            }.value

            // A newer render may have finished first if settings were changed
            // twice in quick succession.
            if next.revision >= rendered.revision { rendered = next }
        }
        .onDisappear { model.teardown() }
        .preferredColorScheme(settings.theme.colorScheme)
        .tint(settings.theme.accent)
    }
}

/// Persistent mini-player, matching the spec's home-screen dock.
private struct MiniPlayer: View {
    @ObservedObject var model: ReaderModel
    /// Observed directly: `PlaybackEngine` is its own ObservableObject, and a
    /// view watching only `model` never hears the playhead move.
    @ObservedObject var engine: PlaybackEngine
    let theme: ReadingTheme
    let onExpand: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            Button {
                Task { await model.toggle() }
            } label: {
                Image(systemName: engine.isPlaying ? "pause.fill" : "play.fill")
                    .font(.title3)
                    .frame(width: 44, height: 44)
                    .background(theme.accent, in: Circle())
                    .foregroundStyle(theme.wordForeground)
            }
            .disabled(model.index == nil)

            VStack(alignment: .leading, spacing: 3) {
                if let synthesis = model.synthesis {
                    Text("Preparing audio \(synthesis.done)/\(synthesis.total)")
                        .font(.caption)
                        .foregroundStyle(theme.secondaryText)
                } else {
                    Text("\(engine.mediaMs.asPlaybackTime) / \(engine.durationMs.asPlaybackTime)")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(theme.secondaryText)
                }
                ProgressView(value: model.progress).tint(theme.accent)
            }

            Button(action: onExpand) {
                Text(String(format: "%.1f×", engine.speed))
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(theme.accent)
            }
            .accessibilityLabel("Playback controls")
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.regularMaterial)
    }
}

private struct HandoffBanner: View {
    let state: ReadingState
    let theme: ReadingTheme
    let onAccept: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack {
            Image(systemName: "arrow.triangle.2.circlepath")
            Text("Another device is at \(Int(state.progress * 100))%.")
                .font(.footnote)
            Spacer()
            Button("Jump", action: onAccept).font(.footnote.weight(.semibold))
            Button("Stay", action: onDismiss).font(.footnote)
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(theme.accent.opacity(0.15))
    }
}


/// The inputs that change what the rendered text looks like. Deliberately does
/// not include the active word: that moves several times a second and is
/// applied by mutating attributes rather than rebuilding the document.
private struct RenderKey: Equatable {
    let documentId: String
    let highlights: Int
    let typeface: ReadingTypeface
    let fontSize: Double
    let theme: ReadingTheme
}
