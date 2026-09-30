import SwiftUI

//  The design system from the spec, as SwiftUI values.

enum ReadingTheme: String, CaseIterable, Identifiable {
    case light, sepia, dark

    var id: String { rawValue }
    var label: String { rawValue.capitalized }

    var background: Color {
        switch self {
        case .light: return Color(red: 0.980, green: 0.980, blue: 0.976) // #FAFAF9
        // True black on iOS, not the web build's #121212: on an OLED panel an
        // unlit pixel draws no power, which matters on a long commute.
        case .dark: return .black
        case .sepia: return Color(red: 0.957, green: 0.933, blue: 0.867)  // #F4EEDD
        }
    }

    var text: Color {
        switch self {
        case .light: return Color(red: 0.110, green: 0.098, blue: 0.090)  // #1C1917
        case .dark: return Color(red: 0.925, green: 0.914, blue: 0.902)
        case .sepia: return Color(red: 0.263, green: 0.180, blue: 0.106)  // #432E1B
        }
    }

    var secondaryText: Color { text.opacity(0.62) }

    var accent: Color {
        switch self {
        case .light: return Color(red: 0.706, green: 0.325, blue: 0.039)
        case .dark: return Color(red: 0.961, green: 0.620, blue: 0.294)
        case .sepia: return Color(red: 0.604, green: 0.298, blue: 0.090)
        }
    }

    /// Soft tint behind the sentence being spoken.
    var sentenceTint: Color { accent.opacity(0.15) }

    /// The word pill: a solid contrast mark that carries the eye across the line.
    var wordBackground: Color {
        switch self {
        case .dark: return accent
        default: return text
        }
    }

    var wordForeground: Color {
        switch self {
        case .dark: return .black
        default: return background
        }
    }

    var surface: Color {
        switch self {
        case .light: return .white
        case .dark: return Color(white: 0.11)
        case .sepia: return Color(red: 0.984, green: 0.969, blue: 0.925)
        }
    }

    var colorScheme: ColorScheme { self == .dark ? .dark : .light }
}

enum ReadingTypeface: String, CaseIterable, Identifiable {
    case sans, serif, dyslexic

    var id: String { rawValue }

    var label: String {
        switch self {
        case .sans: return "Sans"
        case .serif: return "Serif"
        case .dyslexic: return "Dyslexic"
        }
    }

    /// OpenDyslexic ships with the app; the others use the system faces, which
    /// are what iOS readers already have their accessibility settings tuned for.
    func font(size: CGFloat) -> Font {
        switch self {
        case .sans: return .system(size: size, design: .default)
        case .serif: return .system(size: size, design: .serif)
        case .dyslexic: return .custom("OpenDyslexic", size: size)
        }
    }

    var lineSpacingMultiplier: CGFloat {
        switch self {
        case .sans: return 0.62
        case .serif: return 0.68
        // OpenDyslexic is bottom-heavy and needs more room to stay legible.
        case .dyslexic: return 0.80
        }
    }
}

/// Reading preferences, persisted across launches.
///
/// Backed by UserDefaults directly rather than `@AppStorage`. `@AppStorage` is
/// a `DynamicProperty`: it only works inside a `View`, where SwiftUI installs
/// it and drives updates. Used inside an `ObservableObject` it neither
/// publishes changes nor reliably reads them back, so every setting here would
/// appear to save and then silently fail to apply.
@MainActor
final class ReaderSettings: ObservableObject {
    private let defaults: UserDefaults

    @Published var theme: ReadingTheme { didSet { write(theme.rawValue, "theme") } }
    @Published var typeface: ReadingTypeface { didSet { write(typeface.rawValue, "typeface") } }
    @Published var fontSize: Double { didSet { write(fontSize, "fontSize") } }
    @Published var autoScroll: Bool { didSet { write(autoScroll, "autoScroll") } }
    @Published var sentenceHighlight: Bool { didSet { write(sentenceHighlight, "sentenceHighlight") } }
    @Published var speed: Double { didSet { write(speed, "speed") } }
    @Published var voiceId: String { didSet { write(voiceId, "voiceId") } }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        theme = ReadingTheme(rawValue: defaults.string(forKey: Self.key("theme")) ?? "") ?? .light
        typeface = ReadingTypeface(rawValue: defaults.string(forKey: Self.key("typeface")) ?? "") ?? .sans
        // `double(forKey:)` returns 0 for a missing key, which would render the
        // document at zero point size rather than falling back.
        let storedSize = defaults.double(forKey: Self.key("fontSize"))
        fontSize = storedSize > 0 ? storedSize : 19
        let storedSpeed = defaults.double(forKey: Self.key("speed"))
        speed = storedSpeed > 0 ? storedSpeed : 1
        autoScroll = defaults.object(forKey: Self.key("autoScroll")) as? Bool ?? true
        sentenceHighlight = defaults.object(forKey: Self.key("sentenceHighlight")) as? Bool ?? true
        voiceId = defaults.string(forKey: Self.key("voiceId")) ?? ""
    }

    private static func key(_ name: String) -> String { "pagecast.\(name)" }

    private func write(_ value: Any, _ name: String) {
        defaults.set(value, forKey: Self.key(name))
    }
}

extension Int {
    /// Milliseconds as a clock string, matching the web client's formatting.
    var asPlaybackTime: String {
        guard self > 0 else { return "0:00" }
        let total = self / 1000
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, seconds)
            : String(format: "%d:%02d", minutes, seconds)
    }
}
