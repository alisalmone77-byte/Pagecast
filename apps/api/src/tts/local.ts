import { encodeWav } from './wav.js';
import type { SynthesisRequest, SynthesisResult, TtsProvider } from './types.js';
import type { Voice } from '@pagecast/core';

/**
 * The offline provider.
 *
 * This does not speak: it renders a soft marker tone per word over the exact
 * duration that word is allotted. That makes the whole pipeline -- chunking,
 * timelines, highlighting, scrubbing, prefetch, cross-device resume -- runnable
 * and testable with no credentials and no network, and it makes desynchronised
 * highlighting audible rather than something you have to squint at.
 *
 * It is a development and CI provider. Set PAGECAST_TTS_PROVIDER=openai with an
 * API key for real speech.
 */

const SAMPLE_RATE = 22_050;
/** Quiet enough to listen to while reading, loud enough to hear the beat. */
const AMPLITUDE = 0.055;

const VOICES: Voice[] = [
  { id: 'local-clara', label: 'Clara (offline)', accent: 'British English', gender: 'female', provider: 'local', baseWpm: 168 },
  { id: 'local-miles', label: 'Miles (offline)', accent: 'American English', gender: 'male', provider: 'local', baseWpm: 160 },
  { id: 'local-nova', label: 'Nova (offline)', accent: 'Neutral', gender: 'neutral', provider: 'local', baseWpm: 175 },
];

export class LocalTtsProvider implements TtsProvider {
  readonly id = 'local';

  voices(): readonly Voice[] {
    return VOICES;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    const { plan, voice } = request;
    if (plan.length === 0) {
      return {
        audio: encodeWav(new Float32Array(0), SAMPLE_RATE),
        ext: 'wav', mimeType: 'audio/wav', durationMs: 0, marks: [],
      };
    }

    // Lay the words out at this voice's speaking rate, honouring the pauses the
    // planner computed. Because we place them ourselves, the marks are exact.
    const msPerSyllable = 60_000 / Math.max(60, voice.baseWpm) / 1.45;
    const marks: Array<{ blockIndex: number; tokenIndex: number; startMs: number; endMs: number }> = [];

    let cursorMs = 0;
    for (const entry of plan) {
      const spokenMs = Math.max(90, entry.cost * msPerSyllable);
      marks.push({
        blockIndex: entry.blockIndex,
        tokenIndex: entry.tokenIndex,
        startMs: Math.round(cursorMs),
        endMs: Math.round(cursorMs + spokenMs),
      });
      cursorMs += spokenMs + entry.pauseMs;
    }

    const durationMs = Math.ceil(cursorMs);
    const samples = new Float32Array(Math.ceil((durationMs / 1000) * SAMPLE_RATE));

    // One short tone per word. Pitch tracks word length so the rhythm of the
    // text is audible; a raised-cosine envelope keeps it from clicking.
    for (const mark of marks) {
      const start = Math.floor((mark.startMs / 1000) * SAMPLE_RATE);
      const length = Math.max(1, Math.floor(((mark.endMs - mark.startMs) / 1000) * SAMPLE_RATE));
      const frequency = 210 + ((mark.tokenIndex * 37) % 130);
      for (let i = 0; i < length; i += 1) {
        const n = start + i;
        if (n >= samples.length) break;
        const envelope = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
        samples[n] = Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE) * envelope * AMPLITUDE;
      }
    }

    return {
      audio: encodeWav(samples, SAMPLE_RATE),
      ext: 'wav',
      mimeType: 'audio/wav',
      durationMs,
      marks,
    };
  }
}
