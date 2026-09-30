import { config } from '../config.js';
import { parseWav } from './wav.js';
import type { SynthesisRequest, SynthesisResult, TtsProvider } from './types.js';
import type { Voice } from '@pagecast/core';

/**
 * OpenAI text-to-speech.
 *
 * WAV is requested rather than MP3 so the exact duration can be read straight
 * off the header. That number is what the timing model normalises against, and
 * an MP3 duration derived from bitrate is an estimate -- an estimate that would
 * put the highlight progressively out of step over a long chunk.
 *
 * The API reports no word boundaries, so `marks` is left unset and the caller
 * falls back to estimated timings fitted to this duration.
 */

const VOICES: Voice[] = [
  { id: 'openai-alloy',   label: 'Alloy',   accent: 'American English', gender: 'neutral', provider: 'openai', baseWpm: 170 },
  { id: 'openai-nova',    label: 'Nova',    accent: 'American English', gender: 'female',  provider: 'openai', baseWpm: 175 },
  { id: 'openai-shimmer', label: 'Shimmer', accent: 'American English', gender: 'female',  provider: 'openai', baseWpm: 168 },
  { id: 'openai-onyx',    label: 'Onyx',    accent: 'American English', gender: 'male',    provider: 'openai', baseWpm: 158 },
  { id: 'openai-fable',   label: 'Fable',   accent: 'British English',  gender: 'neutral', provider: 'openai', baseWpm: 165 },
  { id: 'openai-echo',    label: 'Echo',    accent: 'American English', gender: 'male',    provider: 'openai', baseWpm: 162 },
];

export class OpenAiTtsProvider implements TtsProvider {
  readonly id = 'openai';

  constructor(private readonly apiKey: string = config.tts.openaiApiKey) {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is required when PAGECAST_TTS_PROVIDER=openai');
    }
  }

  voices(): readonly Voice[] {
    return VOICES;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    const voiceName = request.voice.id.replace(/^openai-/, '');

    const response = await fetch(`${config.tts.openaiBaseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.tts.openaiModel,
        voice: voiceName,
        input: request.text,
        response_format: 'wav',
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`OpenAI TTS returned ${response.status}: ${detail.slice(0, 400)}`);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    const info = parseWav(audio);
    return {
      audio,
      ext: 'wav',
      mimeType: 'audio/wav',
      durationMs: info.durationMs,
      // No word boundaries from this API; timings are estimated and fitted.
    };
  }
}
