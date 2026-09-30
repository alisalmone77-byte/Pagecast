import SwiftUI

//  Screen 1: Library and quick launch.

/// Which slice of the library is showing.
///
/// An explicit enum rather than the `String??` this started as: a double
/// optional where `.some(nil)` means Unfiled and `nil` means no filter is
/// technically expressible but reads as a puzzle, and one misplaced `.some`
/// silently shows the wrong documents.
enum FolderFilter: Hashable {
    case all
    case unfiled
    case folder(String)

    var folderId: String? {
        if case let .folder(id) = self { return id }
        return nil
    }
}

@MainActor
final class LibraryModel: ObservableObject {
    @Published var entries: [LibraryEntry] = []
    @Published var folders: [FolderSummary] = []
    @Published var unfiled = 0
    @Published var selectedFolder: FolderFilter = .all
    @Published var isLoading = true
    @Published var errorMessage: String?
    @Published var search = ""

    var upNext: LibraryEntry? {
        entries
            .filter { ($0.state?.progress ?? 0) > 0.005 && ($0.state?.progress ?? 0) < 0.995 }
            .max { ($0.state?.updatedAt ?? "") < ($1.state?.updatedAt ?? "") }
    }

    /// Folders ordered for a picker: each parent immediately followed by its
    /// own children, so the indent points at something.
    var orderedFolders: [(folder: FolderSummary, depth: Int)] {
        var out: [(FolderSummary, Int)] = []
        for root in folders.filter({ $0.parentId == nil }) {
            out.append((root, 0))
            for child in folders.filter({ $0.parentId == root.id }) { out.append((child, 1)) }
        }
        return out
    }

    var recents: [LibraryEntry] {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        var filtered = needle.isEmpty ? entries : entries.filter {
            $0.meta.title.lowercased().contains(needle)
                || ($0.meta.author?.lowercased().contains(needle) ?? false)
        }
        switch selectedFolder {
        case .all: break
        case .unfiled: filtered = filtered.filter { $0.meta.folderId == nil }
        case let .folder(id): filtered = filtered.filter { $0.meta.folderId == id }
        }
        return filtered.sorted { $0.meta.updatedAt > $1.meta.updatedAt }
    }

    var currentFolderName: String? {
        switch selectedFolder {
        case .all: return nil
        case .unfiled: return "Unfiled"
        case let .folder(id): return folders.first { $0.id == id }?.name
        }
    }

    func load() async {
        isLoading = entries.isEmpty
        do {
            async let documents = APIClient.shared.library()
            async let folderList = APIClient.shared.folders()
            entries = try await documents
            let loaded = try await folderList
            folders = loaded.folders
            unfiled = loaded.unfiled
            errorMessage = nil
        } catch let error as APIError where error.isUnauthorized {
            // The session ended elsewhere; the app returns to sign-in.
            await SessionStore.shared.signOutLocally()
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
        await load()
    }

    func move(_ entry: LibraryEntry, to folderId: String?) async {
        do {
            try await APIClient.shared.move(documentIds: [entry.id], toFolder: folderId)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func createFolder(named name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        do {
            _ = try await APIClient.shared.createFolder(name: trimmed, parentId: nil)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func deleteFolder(_ id: String) async {
        do {
            try await APIClient.shared.deleteFolder(id)
            if selectedFolder == .folder(id) { selectedFolder = .all }
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct LibraryView: View {
    @EnvironmentObject private var settings: ReaderSettings
    @EnvironmentObject private var session: SessionStore
    @StateObject private var model = LibraryModel()
    @State private var showingNewFolder = false
    @State private var newFolderName = ""
    @State private var showingAdd = false
    @State private var showingScanner = false
    @State private var selection: DocumentMeta?
    @State private var movingEntry: LibraryEntry?

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
                                .swipeActions(edge: .leading) {
                                    if !model.folders.isEmpty {
                                        Button {
                                            movingEntry = entry
                                        } label: {
                                            Label("Move", systemImage: "folder")
                                        }
                                        .tint(settings.theme.accent)
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
            .navigationTitle(model.currentFolderName ?? "Pagecast")
            .searchable(text: $model.search, prompt: "Search your library")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Picker("Folder", selection: $model.selectedFolder) {
                            Text("All documents").tag(FolderFilter.all)
                            Text("Unfiled (\(model.unfiled))").tag(FolderFilter.unfiled)
                            ForEach(model.orderedFolders, id: \.folder.id) { entry in
                                Text(entry.depth > 0 ? "   \(entry.folder.name)" : entry.folder.name)
                                    .tag(FolderFilter.folder(entry.folder.id))
                            }
                        }
                        Divider()
                        Button { showingNewFolder = true } label: {
                            Label("New folder", systemImage: "folder.badge.plus")
                        }
                        if let id = model.selectedFolder.folderId {
                            Button(role: .destructive) {
                                Task { await model.deleteFolder(id) }
                            } label: {
                                Label("Delete this folder", systemImage: "trash")
                            }
                        }
                    } label: {
                        Image(systemName: model.selectedFolder == .all ? "folder" : "folder.fill")
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { showingScanner = true } label: {
                            Label("Scan pages", systemImage: "camera.viewfinder")
                        }
                        Button { showingAdd = true } label: {
                            Label("Add link or text", systemImage: "link")
                        }
                        Divider()
                        if let user = session.user {
                            Text(user.email)
                        }
                        Button(role: .destructive) {
                            Task { await session.signOut() }
                        } label: {
                            Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .alert("New folder", isPresented: $showingNewFolder) {
                TextField("Name", text: $newFolderName)
                Button("Create") {
                    Task { await model.createFolder(named: newFolderName); newFolderName = "" }
                }
                Button("Cancel", role: .cancel) { newFolderName = "" }
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
            .confirmationDialog(
                "Move to folder",
                isPresented: Binding(get: { movingEntry != nil }, set: { if !$0 { movingEntry = nil } })
            ) {
                Button("Unfiled") {
                    if let entry = movingEntry { Task { await model.move(entry, to: nil) } }
                    movingEntry = nil
                }
                ForEach(model.orderedFolders, id: \.folder.id) { entry in
                    Button(entry.folder.name) {
                        if let moving = movingEntry {
                            Task { await model.move(moving, to: entry.folder.id) }
                        }
                        movingEntry = nil
                    }
                }
                Button("Cancel", role: .cancel) { movingEntry = nil }
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

