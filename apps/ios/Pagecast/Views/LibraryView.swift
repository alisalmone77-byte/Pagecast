import SwiftUI

//  Screen 1: Library and quick launch.

@MainActor
final class LibraryModel: ObservableObject {
    @Published var entries: [LibraryEntry] = []
    @Published var isLoading = true
    @Published var errorMessage: String?
    @Published var search = ""

    var upNext: LibraryEntry? {
        entries
            .filter { ($0.state?.progress ?? 0) > 0.005 && ($0.state?.progress ?? 0) < 0.995 }
            .max { ($0.state?.updatedAt ?? "") < ($1.state?.updatedAt ?? "") }
    }

    var recents: [LibraryEntry] {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        let filtered = needle.isEmpty ? entries : entries.filter {
            $0.meta.title.lowercased().contains(needle)
                || ($0.meta.author?.lowercased().contains(needle) ?? false)
        }
        return filtered.sorted { $0.meta.updatedAt > $1.meta.updatedAt }
    }

    func load() async {
        isLoading = entries.isEmpty
        do {
            entries = try await APIClient.shared.library()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    func delete(_ entry: LibraryEntry) async {
        let previous = entries
        entries.removeAll { $0.id == entry.id }
        do {
            try await APIClient.shared.deleteDocument(entry.id)
            await AudioCache.shared.evict(documentId: entry.id)
        } catch {
            entries = previous
            errorMessage = error.localizedDescription
        }
    }
}

struct LibraryView: View {
    @EnvironmentObject private var settings: ReaderSettings
    @StateObject private var model = LibraryModel()
    @State private var showingAdd = false
    @State private var showingScanner = false
    @State private var selection: DocumentMeta?

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if let upNext = model.upNext, model.search.isEmpty {
                        ContinueCard(entry: upNext, theme: settings.theme) {
                            selection = upNext.meta
                        }
                    }

                    if !model.recents.isEmpty {
                        Text("Recent documents")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(settings.theme.secondaryText)
                            .textCase(.uppercase)
                            .padding(.horizontal)

                        ForEach(model.recents) { entry in
                            DocumentRow(entry: entry, theme: settings.theme)
                                .contentShape(Rectangle())
                                .onTapGesture { selection = entry.meta }
                                .swipeActions(edge: .trailing) {
                                    Button(role: .destructive) {
                                        Task { await model.delete(entry) }
                                    } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                        }
                    } else if !model.isLoading {
                        EmptyLibrary(theme: settings.theme) { showingScanner = true }
                    }
                }
                .padding(.vertical)
            }
            .background(settings.theme.background)
            .scrollContentBackground(.hidden)
            .navigationTitle("Pagecast")
            .searchable(text: $model.search, prompt: "Search your library")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { showingScanner = true } label: {
                            Label("Scan pages", systemImage: "camera.viewfinder")
                        }
                        Button { showingAdd = true } label: {
                            Label("Add link or text", systemImage: "link")
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .refreshable { await model.load() }
            .task { await model.load() }
            .navigationDestination(item: $selection) { meta in
                ReaderView(meta: meta)
                    .environmentObject(settings)
            }
            .sheet(isPresented: $showingScanner) {
                ScannerFlow { meta in
                    showingScanner = false
                    selection = meta
                    Task { await model.load() }
                }
            }
            .sheet(isPresented: $showingAdd) {
                AddSourceSheet { meta in
                    showingAdd = false
                    selection = meta
                    Task { await model.load() }
                }
            }
            .alert("Something went wrong", isPresented: .constant(model.errorMessage != nil)) {
                Button("OK") { model.errorMessage = nil }
            } message: {
                Text(model.errorMessage ?? "")
            }
        }
        .tint(settings.theme.accent)
        .preferredColorScheme(settings.theme.colorScheme)
    }
}

/// The "Up Next" hero card, with a one-tap resume.
private struct ContinueCard: View {
    let entry: LibraryEntry
    let theme: ReadingTheme
    let onResume: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Continue listening")
                .font(.caption.weight(.bold))
                .textCase(.uppercase)
                .foregroundStyle(theme.accent)

            Text(entry.meta.title)
                .font(.title2.weight(.bold))
                .foregroundStyle(theme.text)
                .lineLimit(2)

            let progress = entry.state?.progress ?? 0
            Text("\(Int(progress * 100))% · \(remainingLabel) left")
                .font(.footnote)
                .foregroundStyle(theme.secondaryText)
                .monospacedDigit()

            ProgressView(value: progress)
                .tint(theme.accent)

            Button(action: onResume) {
                Label("Resume", systemImage: "play.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding()
        .background(theme.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(theme.accent.opacity(0.2)))
        .padding(.horizontal)
    }

    private var remainingLabel: String {
        let read = Double(entry.meta.wordCount) * (entry.state?.progress ?? 0)
        let minutes = (Double(entry.meta.wordCount) - read) / 165
        return Int(minutes * 60_000).asPlaybackTime
    }
}

private struct DocumentRow: View {
    let entry: LibraryEntry
    let theme: ReadingTheme
    @State private var isCached = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: entry.meta.sourceKind.systemImage)
                .font(.title3)
                .foregroundStyle(theme.accent)
                .frame(width: 38, height: 38)
                .background(theme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))

            VStack(alignment: .leading, spacing: 3) {
                Text(entry.meta.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(theme.text)
                    .lineLimit(2)

                HStack(spacing: 6) {
                    Text(entry.meta.sourceKind.label)
                    Text("·")
                    Text("\(entry.meta.wordCount) words")
                    if isCached {
                        Text("·")
                        // Tells the reader this one will work on the Tube.
                        Image(systemName: "arrow.down.circle.fill")
                            .accessibilityLabel("Available offline")
                    }
                }
                .font(.caption)
                .foregroundStyle(theme.secondaryText)

                if let progress = entry.state?.progress, progress > 0.005 {
                    ProgressView(value: progress)
                        .tint(theme.accent)
                        .scaleEffect(y: 0.6, anchor: .center)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal)
        .padding(.vertical, 6)
        .task {
            // Only meaningful once a timeline exists, so this is best-effort.
            isCached = entry.meta.audioState == .ready
        }
    }
}

private struct EmptyLibrary: View {
    let theme: ReadingTheme
    let onScan: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "text.book.closed")
                .font(.system(size: 42))
                .foregroundStyle(theme.secondaryText)
            Text("Nothing here yet")
                .font(.headline)
                .foregroundStyle(theme.text)
            Text("Scan a page with the camera, share a link from Safari, or drop a PDF in from the web app.")
                .font(.subheadline)
                .foregroundStyle(theme.secondaryText)
                .multilineTextAlignment(.center)
            Button(action: onScan) {
                Label("Scan a page", systemImage: "camera.viewfinder")
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity)
        .padding(40)
    }
}

