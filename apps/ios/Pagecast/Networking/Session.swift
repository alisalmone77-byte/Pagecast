import Combine
import Foundation
import Security

//  Session storage.
//
//  The token goes in the keychain rather than UserDefaults. UserDefaults is a
//  plist in the app container: readable from a file-system backup, and not
//  protected when the device is locked. `kSecAttrAccessibleAfterFirstUnlock`
//  keeps the token available to background audio and background sync after the
//  first unlock following a reboot, without leaving it readable on a device
//  that has never been unlocked.

@MainActor
final class SessionStore: ObservableObject {
    static let shared = SessionStore()

    @Published private(set) var user: PublicUser?
    @Published private(set) var isRestoring = true

    private let service = "com.pagecast.app.session"
    private let account = "session-token"

    /// Shared with the share extension, which runs in its own process with its
    /// own container and cannot otherwise see the app's keychain item. The
    /// group must match the `keychain-access-groups` entitlement on both
    /// targets, and is prefixed at runtime with the team id.
    static let accessGroup = "$(AppIdentifierPrefix)com.pagecast.shared"
    private var accessGroup: String? { Self.accessGroup }

    /// The stored session token, or nil when signed out.
    @Published private(set) var token: String? {
        didSet { APIClient.shared.setToken(token) }
    }

    private init() {
        token = readKeychain()
        APIClient.shared.setToken(token)
    }

    /// Ask the server whether the stored token is still good.
    func restore() async {
        defer { isRestoring = false }
        guard token != nil else { return }
        do {
            user = try await APIClient.shared.me()
        } catch {
            // Expired, revoked, or the server was reset. Drop it quietly.
            await signOutLocally()
        }
    }

    func signIn(email: String, password: String) async throws {
        let result = try await APIClient.shared.login(email: email, password: password)
        adopt(result)
    }

    func register(email: String, password: String, displayName: String?, inviteCode: String?) async throws {
        let result = try await APIClient.shared.register(
            email: email, password: password, displayName: displayName, inviteCode: inviteCode
        )
        adopt(result)
    }

    func signOut() async {
        try? await APIClient.shared.logout()
        await signOutLocally()
    }

    /// Drop local credentials without calling the server -- used when the
    /// server has already told us the session is gone.
    func signOutLocally() async {
        token = nil
        user = nil
        deleteKeychain()
        await AudioCache.shared.evictAll()
    }

    private func adopt(_ result: AuthResult) {
        token = result.token
        user = result.user
        writeKeychain(result.token)
    }

    // MARK: - Keychain

    private func query() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    private func readKeychain() -> String? {
        var query = query()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func writeKeychain(_ value: String) {
        deleteKeychain()
        var attributes = query()
        attributes[kSecValueData as String] = Data(value.utf8)
        // Available after first unlock so background playback and sync keep
        // working with the screen locked.
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attributes as CFDictionary, nil)
    }

    private func deleteKeychain() {
        SecItemDelete(query() as CFDictionary)
    }
}
