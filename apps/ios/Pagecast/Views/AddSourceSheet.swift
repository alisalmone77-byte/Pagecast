import SwiftUI
import UniformTypeIdentifiers

/// Adding a source from a link, pasted text, or the Files app.
struct AddSourceSheet: View {
    let onComplete: (DocumentMeta) -> Void

    @EnvironmentObject private var settings: ReaderSettings
    @Environment(\.dismiss) private var dismiss
    @State private var link = ""
    @State private var text = ""
    @State private var title = ""
    @State private var tab = Tab.link
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var showingImporter = false

    private enum Tab: String, CaseIterable, Identifiable {
        case link, text, file
        var id: String { rawValue }
        var label: String {
            switch self {
            case .link: return "Web link"
            case .text: return "Paste"
            case .file: return "File"
            }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Picker("Source", selection: $tab) {
                    ForEach(Tab.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)

                switch tab {
                case .link:
                    Section {
                        TextField("https://example.com/an-article", text: $link)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                    } footer: {
                        Text("The page is fetched and the article extracted; navigation, ads and comments are left behind.")
                    }

                case .text:
                    Section {
                        TextField("Title (optional)", text: $title)
                        TextEditor(text: $text).frame(minHeight: 160)
                    }

                case .file:
                    Section {
                        Button {
                            showingImporter = true
                        } label: {
                            Label("Choose a file", systemImage: "folder")
                        }
                    } footer: {
                        Text("PDF, EPUB, DOCX or plain text.")
                    }
                }
            }
            .navigationTitle("Add a source")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Add") { Task { await submit() } }
                        .disabled(isWorking || !canSubmit)
                }
            }
            .overlay {
                if isWorking {
                    ProgressView("Extracting text…")
                        .padding(24)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                }
            }
            .fileImporter(
                isPresented: $showingImporter,
                allowedContentTypes: [.pdf, .epub, .plainText, .text,
                                      UTType("org.openxmlformats.wordprocessingml.document") ?? .data]
            ) { result in
                Task { await importFile(result) }
            }
            .alert("Could not add that", isPresented: .constant(errorMessage != nil)) {
                Button("OK") { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    private var canSubmit: Bool {
        switch tab {
        case .link: return !link.trimmingCharacters(in: .whitespaces).isEmpty
        case .text: return !text.trimmingCharacters(in: .whitespaces).isEmpty
        case .file: return false
        }
    }

    private func submit() async {
        isWorking = true
        defer { isWorking = false }
        do {
            let meta: DocumentMeta
            switch tab {
            case .link:
                meta = try await APIClient.shared.ingest(url: link.trimmingCharacters(in: .whitespaces))
            case .text:
                let name = title.trimmingCharacters(in: .whitespaces)
                meta = try await APIClient.shared.ingest(text: text, title: name.isEmpty ? nil : name)
            case .file:
                return
            }
            onComplete(meta)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func importFile(_ result: Result<URL, Error>) async {
        isWorking = true
        defer { isWorking = false }
        do {
            let url = try result.get()
            // A file picked from iCloud Drive or another app is security-scoped.
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }

            let data = try Data(contentsOf: url)
            let meta = try await APIClient.shared.ingest(fileData: data, filename: url.lastPathComponent)
            onComplete(meta)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
