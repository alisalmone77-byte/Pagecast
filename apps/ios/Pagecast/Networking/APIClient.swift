import Foundation

//  REST client. Mirrors apps/web/src/api/client.ts so both clients speak the
//  same protocol to the same server.

enum APIError: LocalizedError {
    case badStatus(Int, String)
    case unauthorized
    case transport(Error)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case let .badStatus(code, message):
            return message.isEmpty ? "The server returned \(code)." : message
        case .unauthorized:
            return "Your session has ended. Sign in again to continue."
        case let .transport(error):
            return error.localizedDescription
        case .decoding:
            return "The server sent something this version of Pagecast does not understand."
        }
    }

    /// True when the session is gone and the UI should return to sign-in.
    var isUnauthorized: Bool {
        if case .unauthorized = self { return true }
        return false
    }
}

struct PublicUser: Decodable, Identifiable, Equatable {
    let id: String
    let email: String
    let displayName: String
    let createdAt: String
}

struct AuthResult: Decodable {
    let user: PublicUser
    let token: String
}

struct AuthConfig: Decodable {
    let allowRegistration: Bool
    let requiresInvite: Bool
    let hasAccounts: Bool
}

struct FolderSummary: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let parentId: String?
    let sortOrder: Int
    let documentCount: Int
    let totalCount: Int
}

struct FullDocument: Decodable {
    let meta: DocumentMeta
    let content: DocumentContent
    let state: ReadingState
    let highlights: [Highlight]
}

struct LibraryEntry: Decodable, Identifiable {
    let meta: DocumentMeta
    let state: ReadingState?

    var id: String { meta.id }

    /// The library endpoint returns metadata and state flattened together.
    init(from decoder: Decoder) throws {
        meta = try DocumentMeta(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decodeIfPresent(ReadingState.self, forKey: .state)
    }

    private enum CodingKeys: String, CodingKey { case state }
}

actor APIClient {
    static let shared = APIClient()

    /// Points at the development server by default; a build sets
    /// PAGECAST_API_BASE in Info.plist to reach a real deployment.
    private let baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    /// Stable per-install identity, so hand-off can tell this device from others.
    nonisolated static let deviceId: String = {
        let key = "pagecast.deviceId"
        if let existing = UserDefaults.standard.string(forKey: key) { return existing }
        let created = "ios-\(UUID().uuidString.prefix(8))"
        UserDefaults.standard.set(created, forKey: key)
        return created
    }()

    /// The session token, sent as a bearer credential. URLSession has its own
    /// cookie jar, but the token is carried explicitly so the share extension
    /// -- a separate process with a separate jar -- authenticates the same way.
    private var token: String?

    init(baseURL: URL? = nil, session: URLSession = .shared) {
        if let baseURL {
            self.baseURL = baseURL
        } else {
            let configured = Bundle.main.object(forInfoDictionaryKey: "PAGECAST_API_BASE") as? String
            self.baseURL = URL(string: configured ?? "http://localhost:8787")!
        }
        self.session = session
    }

    nonisolated var apiBase: URL { baseURL }

    nonisolated func setToken(_ token: String?) {
        Task { await self.storeToken(token) }
    }

    private func storeToken(_ next: String?) {
        token = next
    }

    /// Set the token and wait for it to land. `setToken` is fire-and-forget,
    /// which is right in the app but not in the share extension, where the
    /// very next call is the authenticated one.
    func setTokenAndWait(_ next: String?) {
        token = next
    }

    /// Exposed so the sync socket can authenticate its upgrade request.
    func currentToken() -> String? { token }

    // MARK: - Requests

    private func request(_ method: String, _ path: String, body: Data? = nil,
                         headers: [String: String] = [:]) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw APIError.badStatus(0, "Could not build a URL for \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(Self.deviceId, forHTTPHeaderField: "x-pagecast-device")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        if let body {
            request.httpBody = body
            if headers["content-type"] == nil {
                request.setValue("application/json", forHTTPHeaderField: "content-type")
            }
        }
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let data = try await sendRaw(request)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    @discardableResult
    private func sendRaw(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.badStatus(0, "The response was not HTTP.")
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw APIError.unauthorized }
            // The server reports failures as { "error": "..." }.
            struct ErrorBody: Decodable { let error: String? }
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            throw APIError.badStatus(http.statusCode, message ?? "")
        }
        return data
    }

    // MARK: - Authentication

    func authConfig() async throws -> AuthConfig {
        try await send(request("GET", "/api/auth/config"), as: AuthConfig.self)
    }

    func me() async throws -> PublicUser {
        struct Response: Decodable { let user: PublicUser }
        return try await send(request("GET", "/api/auth/me"), as: Response.self).user
    }

    func login(email: String, password: String) async throws -> AuthResult {
        let body = try encoder.encode(["email": email, "password": password])
        return try await send(request("POST", "/api/auth/login", body: body), as: AuthResult.self)
    }

    func register(email: String, password: String,
                  displayName: String?, inviteCode: String?) async throws -> AuthResult {
        struct Body: Encodable {
            let email: String
            let password: String
            let displayName: String?
            let inviteCode: String?
        }
        let body = try encoder.encode(
            Body(email: email, password: password, displayName: displayName, inviteCode: inviteCode)
        )
        return try await send(request("POST", "/api/auth/register", body: body), as: AuthResult.self)
    }

    func logout() async throws {
        try await sendRaw(request("POST", "/api/auth/logout"))
    }

    // MARK: - Folders

    func folders() async throws -> (folders: [FolderSummary], unfiled: Int) {
        struct Response: Decodable { let folders: [FolderSummary]; let unfiled: Int }
        let response = try await send(request("GET", "/api/folders"), as: Response.self)
        return (response.folders, response.unfiled)
    }

    func createFolder(name: String, parentId: String?) async throws -> FolderSummary {
        struct Body: Encodable { let name: String; let parentId: String? }
        struct Response: Decodable { let folder: FolderSummary }
        let body = try encoder.encode(Body(name: name, parentId: parentId))
        return try await send(request("POST", "/api/folders", body: body), as: Response.self).folder
    }

    func deleteFolder(_ id: String) async throws {
        try await sendRaw(request("DELETE", "/api/folders/\(id)"))
    }

    func move(documentIds: [String], toFolder folderId: String?) async throws {
        struct Body: Encodable { let documentIds: [String]; let folderId: String? }
        let body = try encoder.encode(Body(documentIds: documentIds, folderId: folderId))
        try await sendRaw(request("POST", "/api/folders/move", body: body))
    }

    // MARK: - Documents

    func library() async throws -> [LibraryEntry] {
        struct Response: Decodable { let documents: [LibraryEntry] }
        return try await send(request("GET", "/api/documents"), as: Response.self).documents
    }

    func continueListening(limit: Int = 5) async throws -> [LibraryEntry] {
        struct Response: Decodable { let documents: [LibraryEntry] }
        return try await send(request("GET", "/api/documents/continue?limit=\(limit)"), as: Response.self).documents
    }

    func document(_ id: String) async throws -> FullDocument {
        try await send(request("GET", "/api/documents/\(id)"), as: FullDocument.self)
    }

    func deleteDocument(_ id: String) async throws {
        try await sendRaw(request("DELETE", "/api/documents/\(id)"))
    }

    func setBookmarked(_ id: String, _ bookmarked: Bool) async throws {
        let body = try encoder.encode(["bookmarked": bookmarked])
        try await sendRaw(request("PATCH", "/api/documents/\(id)", body: body))
    }

    // MARK: - Ingestion

    struct MetaResponse: Decodable { let meta: DocumentMeta }

    /// Raw bytes with the filename in a header: no multipart encoding, and no
    /// base64 inflation of a 40MB PDF on a phone.
    func ingest(fileData: Data, filename: String) async throws -> DocumentMeta {
        let encoded = filename.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "upload"
        let req = try request("POST", "/api/ingest/file", body: fileData, headers: [
            "content-type": "application/octet-stream",
            "x-pagecast-filename": encoded,
        ])
        return try await send(req, as: MetaResponse.self).meta
    }

    func ingest(url: String) async throws -> DocumentMeta {
        let body = try encoder.encode(["url": url])
        return try await send(request("POST", "/api/ingest/url", body: body), as: MetaResponse.self).meta
    }

    /// Scanner output: one string per captured page.
    func ingest(scannedPages: [String], title: String?) async throws -> DocumentMeta {
        struct Body: Encodable {
            let pages: [String]
            let title: String?
            let kind: String
        }
        let body = try encoder.encode(Body(pages: scannedPages, title: title, kind: "scan"))
        return try await send(request("POST", "/api/ingest/text", body: body), as: MetaResponse.self).meta
    }

    func ingest(text: String, title: String?) async throws -> DocumentMeta {
        struct Body: Encodable {
            let text: String
            let title: String?
        }
        let body = try encoder.encode(Body(text: text, title: title))
        return try await send(request("POST", "/api/ingest/text", body: body), as: MetaResponse.self).meta
    }

    // MARK: - Audio

    func voices() async throws -> [Voice] {
        struct Response: Decodable { let voices: [Voice] }
        return try await send(request("GET", "/api/voices"), as: Response.self).voices
    }

    struct SynthesisResponse: Decodable {
        let timeline: Timeline?
        let done: Int?
        let total: Int?
        let error: String?
    }

    func startSynthesis(_ id: String, voiceId: String) async throws -> SynthesisResponse {
        let body = try encoder.encode(["voiceId": voiceId])
        return try await send(request("POST", "/api/documents/\(id)/audio", body: body), as: SynthesisResponse.self)
    }

    func timeline(_ id: String, voiceId: String) async throws -> SynthesisResponse {
        let encoded = voiceId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? voiceId
        return try await send(request("GET", "/api/documents/\(id)/timeline?voiceId=\(encoded)"), as: SynthesisResponse.self)
    }

    /// Absolute URL for a chunk, since the timeline carries server-relative paths.
    nonisolated func absoluteURL(for path: String) -> URL? {
        URL(string: path, relativeTo: baseURL)?.absoluteURL
    }

    func downloadChunk(_ path: String) async throws -> Data {
        guard let url = absoluteURL(for: path) else {
            throw APIError.badStatus(0, "Bad audio URL: \(path)")
        }
        var req = URLRequest(url: url)
        req.setValue(Self.deviceId, forHTTPHeaderField: "x-pagecast-device")
        return try await sendRaw(req)
    }

    // MARK: - Sync

    struct StateResponse: Decodable {
        let state: ReadingState
        let accepted: Bool?
    }

    func putState(_ id: String, position: ReadingPosition, speed: Double,
                  voiceId: String, rev: Int) async throws -> ReadingState {
        struct Body: Encodable {
            let position: ReadingPosition
            let speed: Double
            let voiceId: String
            let rev: Int
            let deviceId: String
        }
        let body = try encoder.encode(
            Body(position: position, speed: speed, voiceId: voiceId, rev: rev, deviceId: Self.deviceId)
        )
        return try await send(request("PUT", "/api/sync/state/\(id)", body: body), as: StateResponse.self).state
    }

    func state(_ id: String) async throws -> ReadingState {
        try await send(request("GET", "/api/sync/state/\(id)"), as: StateResponse.self).state
    }

    // MARK: - Highlights

    func addHighlight(_ id: String, blockIndex: Int, startToken: Int,
                      endToken: Int, note: String?) async throws -> Highlight {
        struct Body: Encodable {
            let blockIndex: Int
            let startToken: Int
            let endToken: Int
            let note: String?
        }
        struct Response: Decodable { let highlight: Highlight }
        let body = try encoder.encode(
            Body(blockIndex: blockIndex, startToken: startToken, endToken: endToken, note: note)
        )
        return try await send(request("POST", "/api/documents/\(id)/highlights", body: body), as: Response.self).highlight
    }
}
