import SwiftUI

@main
struct PagecastApp: App {
    @StateObject private var settings = ReaderSettings()
    @StateObject private var session = SessionStore.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                if session.isRestoring {
                    ProgressView().controlSize(.large)
                } else if session.user == nil {
                    SignInView(session: session)
                } else {
                    LibraryView()
                }
            }
            .environmentObject(settings)
            .environmentObject(session)
            .task {
                await session.restore()
                SyncClient.shared.setToken(session.token)
            }
            .onChange(of: session.token) { _, token in
                SyncClient.shared.setToken(token)
            }
            .onOpenURL { url in
                // The share extension hands articles over on this scheme.
                handle(url)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                if session.user != nil { SyncClient.shared.connect() }
            case .background:
                // Keep the socket only while the app is on screen; playback
                // continues through AVAudioSession without it, and holding a
                // socket open in the background is a battery cost for nothing.
                SyncClient.shared.disconnect()
            default:
                break
            }
        }
    }

    /// pagecast://add?url=… , posted by the share extension.
    private func handle(_ url: URL) {
        guard url.scheme == "pagecast", url.host == "add",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let target = components.queryItems?.first(where: { $0.name == "url" })?.value
        else { return }
        // Nothing to add it to until someone is signed in.
        guard session.user != nil else { return }
        Task { _ = try? await APIClient.shared.ingest(url: target) }
    }
}
