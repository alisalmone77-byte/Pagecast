import {
  buildTimeline, fitPlan, marksToTimings, planChunks, planSentences,
  type AudioChunk, type ChunkTiming, type DocumentContent, type Timeline, type Voice,
} from '@pagecast/core';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { store } from '../store.js';
import { LocalTtsProvider } from './local.js';
import { OpenAiTtsProvider } from './openai.js';
import type { TtsProvider } from './types.js';

export type { SynthesisRequest, SynthesisResult, TtsProvider } from './types.js';

/**
 * Synthesis orchestration: turn a parsed document into audio chunks plus the
 * timeline that maps them back onto words.
 */

let provider: TtsProvider | null = null;

export function getProvider(): TtsProvider {
  if (provider) return provider;
  switch (config.tts.provider) {
    case 'openai':
      provider = new OpenAiTtsProvider();
      break;
    case 'local':
      provider = new LocalTtsProvider();
      break;
    default:
      throw new Error(`unknown TTS provider: ${config.tts.provider}`);
  }
  console.log(`[tts] provider: ${provider.id}`);
  return provider;
}

/** For tests, and for swapping providers without restarting. */
export function setProvider(next: TtsProvider | null): void {
  provider = next;
}

export function listVoices(): readonly Voice[] {
  return getProvider().voices();
}

export function defaultVoice(): Voice {
  const voices = listVoices();
  const first = voices[0];
  if (!first) throw new Error('the TTS provider exposes no voices');
  return first;
}

export function findVoice(voiceId: string | undefined): Voice {
  if (!voiceId) return defaultVoice();
  const voice = listVoices().find((v) => v.id === voiceId);
  if (!voice) throw new HttpError(400, `unknown voice: ${voiceId}`);
  return voice;
}

export interface SynthesisProgress {
  readonly documentId: string;
  readonly voiceId: string;
  readonly done: number;
  readonly total: number;
  readonly timeline: Timeline | null;
  readonly error?: string;
}

/** In-flight synthesis, so two requests for the same document share one run. */
const running = new Map<string, Promise<Timeline>>();
const progress = new Map<string, SynthesisProgress>();

function key(documentId: string, voiceId: string): string {
  return `${documentId}::${voiceId}`;
}

export function getProgress(documentId: string, voiceId: string): SynthesisProgress | null {
  return progress.get(key(documentId, voiceId)) ?? null;
}

/**
 * Synthesise a document, or join the run already in progress.
 *
 * Chunks are synthesised with bounded concurrency and written to disk as they
 * complete, and the timeline is rewritten after each one. A client polling the
 * timeline can therefore start playing chunk 0 while chunk 40 is still being
 * generated, which is the difference between a 50-page PDF being usable in
 * seconds and being usable in minutes.
 */
export function synthesizeDocument(
  documentId: string,
  content: DocumentContent,
  voice: Voice,
  onProgress?: (p: SynthesisProgress) => void,
): Promise<Timeline> {
  const k = key(documentId, voice.id);
  const existing = running.get(k);
  if (existing) return existing;

  const task = run(documentId, content, voice, onProgress).finally(() => {
    running.delete(k);
  });
  running.set(k, task);
  return task;
}

async function run(
  documentId: string,
  content: DocumentContent,
  voice: Voice,
  onProgress?: (p: SynthesisProgress) => void,
): Promise<Timeline> {
  const k = key(documentId, voice.id);
  const plans = planChunks(content);
  const tts = getProvider();

  if (plans.length === 0) {
    const empty = buildTimeline(voice.id, [], content, false);
    await store.saveTimeline(documentId, empty);
    return empty;
  }

  const parts: Array<ChunkTiming | null> = new Array(plans.length).fill(null);
  let done = 0;
  let precise = true;
  let markedPartial = false;

  const publish = async (): Promise<Timeline> => {
    // Chunk start times depend on every earlier chunk's real duration, so the
    // timeline is only well defined up to the first gap.
    const ready: ChunkTiming[] = [];
    let offsetMs = 0;
    for (const part of parts) {
      if (!part) break;
      const chunk: AudioChunk = { ...part.chunk, startMs: offsetMs };
      const shift = offsetMs - part.chunk.startMs;
      ready.push({
        chunk,
        words: shift === 0
          ? part.words
          : part.words.map((w) => ({ ...w, startMs: w.startMs + shift, endMs: w.endMs + shift })),
      });
      offsetMs += part.chunk.durationMs;
    }

    const timeline = buildTimeline(voice.id, ready, content, precise);
    await store.saveTimeline(documentId, timeline);
    const snapshot: SynthesisProgress = {
      documentId, voiceId: voice.id, done, total: plans.length, timeline,
    };
    progress.set(k, snapshot);
    onProgress?.(snapshot);

    // Advertise partial audio as soon as the first chunk lands, so the library
    // can offer play rather than a spinner while the rest is still rendering.
    if (!markedPartial && done > 0 && done < plans.length) {
      markedPartial = true;
      await store.updateMeta(documentId, { audioState: 'partial' }).catch(() => undefined);
    }
    return timeline;
  };

  await store.updateMeta(documentId, { audioState: 'pending' }).catch(() => undefined);
  progress.set(k, { documentId, voiceId: voice.id, done: 0, total: plans.length, timeline: null });

  // Bounded concurrency: workers pull from a shared cursor.
  let next = 0;
  const workerCount = Math.max(1, Math.min(config.synthesisConcurrency, plans.length));

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const plan = plans[index];
      if (!plan) return;

      const timingPlan = planSentences(content, plan.startSentence, plan.endSentence);
      const result = await tts.synthesize({ text: plan.text, voice, plan: timingPlan });
      await store.saveAudioChunk(documentId, voice.id, plan.index, result.ext, result.audio);

      const chunk: AudioChunk = {
        index: plan.index,
        // Provisional; rewritten in publish() once earlier durations are known.
        startMs: 0,
        durationMs: result.durationMs,
        url: `/api/documents/${documentId}/audio/${voice.id}/${plan.index}.${result.ext}`,
        startSentence: plan.startSentence,
        endSentence: plan.endSentence,
      };

      const words = result.marks
        ? marksToTimings(result.marks, result.durationMs, 0)
        : fitPlan(timingPlan, result.durationMs, 0);
      if (!result.marks) precise = false;

      parts[index] = { chunk, words };
      done += 1;
      await publish();
    }
  };

  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    progress.set(k, {
      documentId, voiceId: voice.id, done, total: plans.length,
      timeline: await store.getTimeline(documentId, voice.id),
      error: message,
    });
    await store.updateMeta(documentId, { audioState: 'failed' }).catch(() => undefined);
    throw err;
  }

  const timeline = await publish();
  await store.updateMeta(documentId, { audioState: 'ready' }).catch(() => undefined);
  return timeline;
}
