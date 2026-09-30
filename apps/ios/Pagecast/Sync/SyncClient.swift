import Foundation

//  Live hand-off over a WebSocket, using URLSessionWebSocketTask.
//
//  Push only. Every change is also written over REST, so a phone that cannot
//  hold a socket open -- backgrounded, on a captive network, in a tunnel --
//  loses live updates and nothing else. Reconnects use exponential backoff
//  with jitter so a server restart does not bring every device back at once.

@MainActor
final class SyncClient: ObservableObject {
    static let shared = SyncClient()

    /// The most recent state pushed from another device, if any.
    @Published private(set) var incoming: ReadingState?
    @Published private(set) var isConnected = false

    private var task: URLSessionWebSocketTask?
    private var session: URLSession = .shared
    private var subscriptions: Set<String> = []
    private var reconnectAttempt = 0
    private var reconnectWork: Task<Void, Never>?
    private var closedByUs = false

    private struct ServerMessage: Decodable {
        let type: String
        let state: ReadingState?
        let originDeviceId: String?
        let documentId: String?
        let done: Int?
        let total: Int?
    }

    func connect() {
        guard task == nil else { return }
        closedByUs = false

        let base = APIClient.shared.apiBase
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.scheme = (base.scheme == "https") ? "wss" : "ws"
        components?.path = "/api/sync/ws"
        components?.queryItems = [
            URLQueryItem(name: "user", value: APIClient.userId),
            URLQueryItem(name: "device", value: APIClient.deviceId),
        ]
        guard let url = components?.url else { return }

        let socket = session.webSocketTask(with: url)
        task = socket
        socket.resume()
        isConnected = true
        reconnectAttempt = 0

        if !subscriptions.isEmpty {
            send(["type": "subscribe", "documentIds": Array(subscriptions)])
        }
        receive()
    }

    func disconnect() {
        closedByUs = true
        reconnectWork?.cancel()
        reconnectWork = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        isConnected = false
    }

    func subscribe(_ documentId: String) {
        subscriptions.insert(documentId)
        send(["type": "subscribe", "documentIds": [documentId]])
    }

    func unsubscribe(_ documentId: String) {
        subscriptions.remove(documentId)
        send(["type": "unsubscribe", "documentIds": [documentId]])
    }

    func clearIncoming() { incoming = nil }

    // MARK: - Internals

    private func send(_ payload: [String: Any]) {
        guard let task, isConnected,
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    private func receive() {
        guard let task else { return }
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case let .success(message):
                    self.handle(message)
                    self.receive()
                case .failure:
                    self.isConnected = false
                    self.task = nil
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data?
        switch message {
        case let .string(text): data = text.data(using: .utf8)
        case let .data(raw): data = raw
        @unknown default: data = nil
        }
        guard let data,
              let parsed = try? JSONDecoder().decode(ServerMessage.self, from: data) else { return }

        if parsed.type == "state", let state = parsed.state {
            // The server already filters these, but guarding here too means a
            // stale socket can never make this device argue with itself.
            guard parsed.originDeviceId != APIClient.deviceId else { return }
            incoming = state
        }
    }

    private func scheduleReconnect() {
        guard !closedByUs, reconnectWork == nil else { return }
        let base = min(30.0, 0.5 * pow(2, Double(reconnectAttempt)))
        // Jitter, so every device does not return on the same tick.
        let delay = base * Double.random(in: 0.5...1.0)
        reconnectAttempt += 1

        reconnectWork = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            await MainActor.run {
                guard let self else { return }
                self.reconnectWork = nil
                self.connect()
            }
        }
    }
}

/// Decides when a position is worth writing to the server.
///
/// Writing on every word would be roughly three requests a second. Writing only
/// on pause loses the last stretch if the app is killed. The compromise: push
/// once the reader has covered enough words, or once enough time has passed, or
/// whenever playback state changes -- which callers signal with `force`.
struct PositionPushGate {
    var minWords = 25
    var minInterval: TimeInterval = 10

    private var lastWordIndex: Int?
    private var lastPush: Date?

    mutating func shouldPush(wordIndex: Int, now: Date = Date(), force: Bool = false) -> Bool {
        guard !force else {
            lastWordIndex = wordIndex
            lastPush = now
            return true
        }
        guard let lastWordIndex, let lastPush else {
            self.lastWordIndex = wordIndex
            self.lastPush = now
            return true
        }
        if now.timeIntervalSince(lastPush) >= minInterval || abs(wordIndex - lastWordIndex) >= minWords {
            self.lastWordIndex = wordIndex
            self.lastPush = now
            return true
        }
        return false
    }
}
