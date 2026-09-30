import SwiftUI

//  Screen 4: playback controls, sized for a thumb.

struct AudioSheet: View {
    @ObservedObject var model: ReaderModel
    @EnvironmentObject private var settings: ReaderSettings
    @Environment(\.dismiss) private var dismiss
    @State private var scrubbing: Double?
    @State private var showingVoices = false

    private var theme: ReadingTheme { settings.theme }

    var body: some View {
        VStack(spacing: 26) {
            Capsule()
                .fill(theme.secondaryText.opacity(0.35))
                .frame(width: 38, height: 5)
                .padding(.top, 8)

            VStack(spacing: 8) {
                // A large target: this gets used one-handed, walking.
                Slider(
                    value: Binding(
                        get: { scrubbing ?? Double(model.engine.mediaMs) },
                        set: { scrubbing = $0 }
                    ),
                    in: 0...Double(max(1, model.engine.durationMs)),
                    onEditingChanged: { editing in
                        guard !editing, let target = scrubbing else { return }
                        Task { await model.seek(toMs: Int(target)) }
                        scrubbing = nil
                    }
                )
                .tint(theme.accent)

                HStack {
                    Text(Int(scrubbing ?? Double(model.engine.mediaMs)).asPlaybackTime)
                    Spacer()
                    Text("−" + (model.engine.durationMs - Int(scrubbing ?? Double(model.engine.mediaMs))).asPlaybackTime)
                }
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(theme.secondaryText)
            }

            HStack(spacing: 34) {
                Button { Task { await model.skip(seconds: -15) } } label: {
                    Image(systemName: "gobackward.15").font(.system(size: 30))
                }
                .accessibilityLabel("Back 15 seconds")

                Button { Task { await model.toggle() } } label: {
                    Image(systemName: model.engine.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 32))
                        .frame(width: 76, height: 76)
                        .background(theme.accent, in: Circle())
                        .foregroundStyle(theme.wordForeground)
                }
                .accessibilityLabel(model.engine.isPlaying ? "Pause" : "Play")

                Button { Task { await model.skip(seconds: 15) } } label: {
                    Image(systemName: "goforward.15").font(.system(size: 30))
                }
                .accessibilityLabel("Forward 15 seconds")
            }
            .foregroundStyle(theme.text)

            VStack(spacing: 10) {
                HStack {
                    Text("Speed").font(.subheadline).foregroundStyle(theme.secondaryText)
                    Spacer()
                    Text(String(format: "%.1f×", model.engine.speed))
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                }
                // 0.5 to 4.5 in 0.1 steps, as specified.
                Slider(
                    value: Binding(
                        get: { model.engine.speed },
                        set: { model.setSpeed($0, settings: settings) }
                    ),
                    in: 0.5...4.5,
                    step: 0.1
                )
                .tint(theme.accent)

                HStack(spacing: 8) {
                    ForEach([1.0, 1.5, 2.0, 2.5, 3.0], id: \.self) { preset in
                        Button {
                            model.setSpeed(preset, settings: settings)
                        } label: {
                            Text(String(format: "%g×", preset))
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(
                                    abs(model.engine.speed - preset) < 0.05
                                        ? theme.accent : theme.accent.opacity(0.12),
                                    in: Capsule()
                                )
                                .foregroundStyle(
                                    abs(model.engine.speed - preset) < 0.05
                                        ? theme.wordForeground : theme.accent
                                )
                        }
                    }
                }
            }

            Button {
                showingVoices = true
            } label: {
                HStack {
                    Image(systemName: "waveform")
                    Text(currentVoiceLabel)
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption)
                }
                .padding()
                .background(theme.surface, in: RoundedRectangle(cornerRadius: 12))
            }
            .foregroundStyle(theme.text)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 22)
        .background(theme.background)
        .presentationDetents([.medium, .large])
        .sheet(isPresented: $showingVoices) {
            VoicePicker(model: model).environmentObject(settings)
        }
    }

    private var currentVoiceLabel: String {
        model.voices.first { $0.id == settings.voiceId }?.label
            ?? model.voices.first?.label
            ?? "Voice"
    }
}

struct VoicePicker: View {
    @ObservedObject var model: ReaderModel
    @EnvironmentObject private var settings: ReaderSettings
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(model.voices) { voice in
                Button {
                    Task { await model.setVoice(voice.id, settings: settings) }
                    dismiss()
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(voice.label).font(.body)
                            Text("\(voice.accent) · \(voice.baseWpm) wpm")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if voice.id == settings.voiceId {
                            Image(systemName: "checkmark").foregroundStyle(settings.theme.accent)
                        }
                    }
                }
                .tint(settings.theme.text)
            }
            .navigationTitle("Voice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium])
    }
}

struct ReadingSettingsSheet: View {
    @EnvironmentObject private var settings: ReaderSettings
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Typeface") {
                    Picker("Typeface", selection: Binding(
                        get: { settings.typeface },
                        set: { settings.typeface = $0 }
                    )) {
                        ForEach(ReadingTypeface.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)

                    HStack {
                        Text("A").font(.caption)
                        Slider(value: $settings.fontSize, in: 15...30, step: 1)
                        Text("A").font(.title3)
                    }
                }

                Section("Theme") {
                    Picker("Theme", selection: Binding(
                        get: { settings.theme },
                        set: { settings.theme = $0 }
                    )) {
                        ForEach(ReadingTheme.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }

                Section("Tracking") {
                    Toggle("Follow along automatically", isOn: $settings.autoScroll)
                    Toggle("Tint the current sentence", isOn: $settings.sentenceHighlight)
                }
            }
            .navigationTitle("Reading")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
        }
    }
}
