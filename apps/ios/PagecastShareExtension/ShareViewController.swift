import UIKit
import Social
import UniformTypeIdentifiers

//  The Safari share sheet: "add this page to Pagecast".
//
//  The extension posts the URL to the server itself rather than handing off to
//  the app. Sharing from Safari should not mean watching another app launch --
//  the reader wants to carry on browsing, and the article will be waiting in
//  the library when they next open Pagecast.

final class ShareViewController: UIViewController {
    private let label = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        buildInterface()
        Task { await handleSharedItem() }
    }

    private func buildInterface() {
        label.text = "Adding to Pagecast…"
        label.font = .preferredFont(forTextStyle: .body)
        label.textAlignment = .center
        label.numberOfLines = 0

        let stack = UIStackView(arrangedSubviews: [spinner, label])
        stack.axis = .vertical
        stack.spacing = 14
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -28),
        ])
        spinner.startAnimating()
    }

    private func handleSharedItem() async {
        guard let shared = await extractURL() else {
            await finish(message: "Pagecast could not find a link to add.", success: false)
            return
        }
        do {
            _ = try await APIClient.shared.ingest(url: shared.absoluteString)
            await finish(message: "Added to Pagecast.", success: true)
        } catch {
            await finish(message: error.localizedDescription, success: false)
        }
    }

    /// Safari offers the page as a URL; some apps offer it only as plain text.
    private func extractURL() async -> URL? {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else { return nil }
        for item in items {
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                    return url
                }
                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                   let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String,
                   let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
                   url.scheme?.hasPrefix("http") == true {
                    return url
                }
            }
        }
        return nil
    }

    @MainActor
    private func finish(message: String, success: Bool) async {
        spinner.stopAnimating()
        label.text = message
        // Long enough to read, short enough not to interrupt.
        try? await Task.sleep(nanoseconds: success ? 700_000_000 : 1_800_000_000)
        extensionContext?.completeRequest(returningItems: nil)
    }
}
