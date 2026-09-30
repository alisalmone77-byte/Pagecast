import SwiftUI

@main
struct PagecastApp: App {
    @StateObject private var settings = ReaderSettings()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            LibraryView()
                .environmentObject(settings)
                .onOpenURL { url in
                    // The share extension hands articles over on this scheme.
                    handle(url)
                }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                SyncClient.shared.connect()
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
        Task { _ = try? await APIClient.shared.ingest(url: target) }
    }
}
