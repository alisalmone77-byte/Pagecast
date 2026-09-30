import type { ProviderMark, TimingPlanEntry, Voice } from '@pagecast/core';
import { config } from '../config.js';
import { concatWav, parseWav } from './wav.js';
import type { SynthesisRequest, SynthesisResult, TtsProvider } from './types.js';

/**
 * Google Cloud Text-to-Speech.
 *
 * The reason to reach for this one over the others: it is the only provider
 * here that reports where each word actually falls in the audio. Wrapping every
 * word in an SSML <mark> and asking for SSML_MARK time pointing returns a
 * timepoint per mark, which maps straight onto the word timings the reader
 * needs. Every other provider leaves the timings estimated and normalised
 * against the clip length -- good, but not the same thing as measured.
 *
 * That is also why it uses v1beta1: time pointing is not in v1.
 */

const ENDPOINT = 'https://texttospeech.googleapis.com/v1beta1/text:synthesize';

/**
 * Google rejects input over 5000 bytes, and SSML marks count towards it. Kept
 * well under so a chunk of unusually long words cannot tip a request over.
 */
const MAX_SSML_BYTES = 4200;

/**
 * A representative slice of the catalogue rather than all ~400 voices, chosen
 * so the picker offers a real choice of accent and register without becoming a
 * list nobody reads. `baseWpm` only seeds duration estimates before the real
 * timings arrive.
 */
const VOICES: Voice[] = [
  { id: 'google-en-GB-Neural2-A', label: 'Amelia',  accent: 'British English',    gender: 'female',  provider: 'google', baseWpm: 165 },
  { id: 'google-en-GB-Neural2-B', label: 'Oliver',  accent: 'British English',    gender: 'male',    provider: 'google', baseWpm: 160 },
  { id: 'google-en-GB-Neural2-D', label: 'Harris',  accent: 'British English',    gender: 'male',    provider: 'google', baseWpm: 158 },
  { id: 'google-en-US-Neural2-C', label: 'Quinn',   accent: 'American English',   gender: 'female',  provider: 'google', baseWpm: 172 },
  { id: 'google-en-US-Neural2-D', label: 'Marlow',  accent: 'American English',   gender: 'male',    provider: 'google', baseWpm: 166 },
  { id: 'google-en-US-Studio-O',  label: 'Juniper', accent: 'American English',   gender: 'female',  provider: 'google', baseWpm: 168 },
  { id: 'google-en-AU-Neural2-A', label: 'Sasha',   accent: 'Australian English', gender: 'female',  provider: 'google', baseWpm: 170 },
  { id: 'google-en-IN-Neural2-A', label: 'Ira',     accent: 'Indian English',     gender: 'female',  provider: 'google', baseWpm: 164 },
];

interface Timepoint {
  markName?: string;
  timeSeconds?: number;
}

interface SynthesizeResponse {
  audioContent?: string;
  timepoints?: Timepoint[];
}

export class GoogleTtsProvider implements TtsProvider {
  readonly id = 'google';

  constructor(private readonly apiKey: string = config.tts.googleApiKey) {
    if (!this.apiKey) {
      throw new Error('GOOGLE_TTS_API_KEY is required when PAGECAST_TTS_PROVIDER=google');
    }
  }

  voices(): readonly Voice[] {
    return VOICES;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    const { plan, voice } = request;
    if (plan.length === 0) {
      return { audio: Buffer.alloc(0), ext: 'wav', mimeType: 'audio/wav', durationMs: 0, marks: [] };
    }

    const { languageCode, name } = parseVoiceId(voice.id);
    const batches = splitForInputLimit(plan);

    const audioParts: Buffer[] = [];
    const marks: ProviderMark[] = [];
    let offsetMs = 0;

    // Sequential, not parallel: the batches are pieces of one continuous
    // passage, and this way a rate-limit reply stops the run instead of
    // arriving four times at once.
    for (const batch of batches) {
      const response = await this.request(buildSsml(batch), languageCode, name);
      const audio = Buffer.from(response.audioContent ?? '', 'base64');
      if (audio.length === 0) throw new Error('Google TTS returned no audio');

      const info = parseWav(audio);
      for (const point of response.timepoints ?? []) {
        const index = markIndex(point.markName);
        const entry = index === null ? undefined : batch[index];
        if (!entry || typeof point.timeSeconds !== 'number') continue;
        marks.push({
          blockIndex: entry.blockIndex,
          tokenIndex: entry.tokenIndex,
          startMs: Math.round(offsetMs + point.timeSeconds * 1000),
        });
      }

      audioParts.push(audio);
      offsetMs += info.durationMs;
    }

    const audio = concatWav(audioParts);
    const durationMs = parseWav(audio).durationMs;

    // Marks arrive in order, but a dropped timepoint would leave a word
    // unmapped; sorting keeps the timeline monotonic either way.
    marks.sort((a, b) => a.startMs - b.startMs);

    return {
      audio,
      ext: 'wav',
      mimeType: 'audio/wav',
      durationMs,
      // Fall back to estimated timings if time pointing came back empty, rather
      // than shipping a timeline with holes in it.
      marks: marks.length === plan.length ? marks : undefined,
    };
  }

  private async request(ssml: string, languageCode: string, name: string): Promise<SynthesizeResponse> {
    const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(this.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: { ssml },
        voice: { languageCode, name },
        // LINEAR16 comes back as a WAV file, so the exact duration is readable
        // from the header instead of inferred from a bitrate.
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24_000 },
        // Playback rate is applied on the device, so synthesis stays at 1.0 and
        // one rendering serves every speed.
        enableTimePointing: ['SSML_MARK'],
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Google TTS returned ${response.status}: ${detail.slice(0, 400)}`);
    }
    return (await response.json()) as SynthesizeResponse;
  }
}

/** `google-en-GB-Neural2-A` -> language `en-GB`, voice `en-GB-Neural2-A`. */
export function parseVoiceId(voiceId: string): { languageCode: string; name: string } {
  const name = voiceId.replace(/^google-/, '');
  const parts = name.split('-');
  const languageCode = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : 'en-US';
  return { languageCode, name };
}

/** `w12` -> 12. */
export function markIndex(markName: string | undefined): number | null {
  if (!markName) return null;
  const match = /^w(\d+)$/.exec(markName);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) ? index : null;
}

/**
 * Build the SSML for one batch: a mark before every word, so each one comes
 * back with its own timepoint.
 *
 * Marks are named by position in the batch rather than by document position,
 * because the caller already knows which entry each index belongs to and short
 * names leave more of the byte budget for the text itself.
 */
export function buildSsml(batch: readonly TimingPlanEntry[]): string {
  const body = batch
    .map((entry, index) => `<mark name="w${index}"/>${escapeSsml(entry.text)}`)
    .join(' ');
  return `<speak>${body}</speak>`;
}

/**
 * Escape the five XML characters. Without this an apostrophe-heavy passage is
 * merely ugly, but a stray `&` or `<` makes Google reject the whole request --
 * and `&` is common in the kind of documents people paste in.
 */
export function escapeSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Split a chunk's word plan into batches whose SSML fits Google's input limit.
 *
 * Pagecast's chunks are sized for prosody, not for one provider's request cap,
 * so a long one has to arrive as several requests and be stitched back
 * together. Splitting here rather than shrinking the chunks keeps the seams a
 * Google-only concern instead of degrading every other provider's audio.
 */
export function splitForInputLimit(
  plan: readonly TimingPlanEntry[],
  limit = MAX_SSML_BYTES,
): TimingPlanEntry[][] {
  const batches: TimingPlanEntry[][] = [];
  let current: TimingPlanEntry[] = [];

  for (const entry of plan) {
    const candidate = [...current, entry];
    if (current.length > 0 && Buffer.byteLength(buildSsml(candidate), 'utf8') > limit) {
      batches.push(current);
      current = [entry];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
