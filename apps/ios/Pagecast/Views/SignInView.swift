import SwiftUI

/// Sign-in and sign-up.
///
/// One screen for both, because on a self-hosted install the first visit is
/// always a sign-up and every visit after that is a sign-in; making people find
/// the right tab is friction with nothing behind it. The server says which
/// case we are in.
struct SignInView: View {
    @EnvironmentObject private var settings: ReaderSettings
    @ObservedObject var session: SessionStore

    @State private var config: AuthConfig?
    @State private var registering = false
    @State private var email = ""
    @State private var password = ""
    @State private var displayName = ""
    @State private var inviteCode = ""
    @State private var busy = false
    @State private var errorMessage: String?
    @FocusState private var focus: Field?

    private enum Field { case email, password, name, invite }

    private var theme: ReadingTheme { settings.theme }
    private var firstRun: Bool { config.map { !$0.hasAccounts } ?? false }

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 8) {
                        Image(systemName: "book.pages")
                            .font(.title3)
                            .foregroundStyle(theme.accent)
                        Text("Pagecast").font(.headline)
                    }
                    .padding(.bottom, 4)

                    Text(firstRun ? "Create the first account"
                         : registering ? "Create an account" : "Sign in")
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(theme.text)

                    Text(firstRun
                         ? "This server has no accounts yet. The one you create now takes ownership of anything already in the library."
                         : "Your library, your progress, and where you left off on every device.")
                        .font(.subheadline)
                        .foregroundStyle(theme.secondaryText)

                    VStack(spacing: 12) {
                        if registering {
                            field("Name", text: $displayName, focus: .name)
                                .textContentType(.name)
                        }

                        field("Email", text: $email, focus: .email)
                            .textContentType(.username)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()

                        SecureField("Password", text: $password)
                            .textContentType(registering ? .newPassword : .password)
                            .focused($focus, equals: .password)
                            .padding(12)
                            .background(theme.surface, in: RoundedRectangle(cornerRadius: 10))
                            .submitLabel(.go)
                            .onSubmit { Task { await submit() } }

                        if registering {
                            Text("At least 10 characters. A few ordinary words you will remember beats a short one you will not.")
                                .font(.caption)
                                .foregroundStyle(theme.secondaryText)
                                .frame(maxWidth: .infinity, alignment: .leading)

                            if config?.requiresInvite == true {
                                field("Invitation code", text: $inviteCode, focus: .invite)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                            }
                        }
                    }

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button {
                        Task { await submit() }
                    } label: {
                        if busy {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text(registering ? "Create account" : "Sign in")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(busy || !canSubmit)

                    if !firstRun, config?.allowRegistration == true {
                        Button(registering ? "I already have an account" : "Create an account instead") {
                            registering.toggle()
                            errorMessage = nil
                        }
                        .font(.footnote)
                        .frame(maxWidth: .infinity)
                    }

                    if config?.allowRegistration == false, !registering {
                        Text("Registration is closed on this server.")
                            .font(.caption)
                            .foregroundStyle(theme.secondaryText)
                            .frame(maxWidth: .infinity)
                    }
                }
                .padding(24)
            }
        }
        .tint(theme.accent)
        .preferredColorScheme(theme.colorScheme)
        .task {
            do {
                let next = try await APIClient.shared.authConfig()
                config = next
                // A server with no accounts can only be signed up to.
                if !next.hasAccounts, next.allowRegistration { registering = true }
            } catch {
                errorMessage = "Could not reach the server. Check the address in Settings and try again."
            }
        }
    }

    private func field(_ label: String, text: Binding<String>, focus field: Field) -> some View {
        TextField(label, text: text)
            .focused($focus, equals: field)
            .padding(12)
            .background(theme.surface, in: RoundedRectangle(cornerRadius: 10))
    }

    private var canSubmit: Bool {
        !email.trimmingCharacters(in: .whitespaces).isEmpty
            && password.count >= (registering ? 10 : 1)
    }

    private func submit() async {
        guard canSubmit, !busy else { return }
        busy = true
        errorMessage = nil
        defer { busy = false }

        do {
            let address = email.trimmingCharacters(in: .whitespaces)
            if registering {
                let name = displayName.trimmingCharacters(in: .whitespaces)
                let code = inviteCode.trimmingCharacters(in: .whitespaces)
                try await session.register(
                    email: address, password: password,
                    displayName: name.isEmpty ? nil : name,
                    inviteCode: code.isEmpty ? nil : code
                )
            } else {
                try await session.signIn(email: address, password: password)
            }
            password = ""
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
