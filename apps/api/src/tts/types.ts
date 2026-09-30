import type { ProviderMark, TimingPlanEntry, Voice } from '@pagecast/core';

export interface SynthesisRequest {
  /** The literal text to speak. */
  readonly text: string;
  readonly voice: Voice;
  /**
   * The words of this chunk in spoken order. A provider that cannot report
   * word boundaries ignores this; one that can uses it to map its own marks
   * back onto document positions.
   */
  readonly plan: readonly TimingPlanEntry[];
}

export interface SynthesisResult {
  readonly audio: Buffer;
  readonly ext: string;
  readonly mimeType: string;
  readonly durationMs: number;
  /**
   * True word boundaries, relative to the start of this chunk. Absent when the
   * provider does not report them, in which case timings are estimated and
   * normalised against `durationMs`.
   */
  readonly marks?: readonly ProviderMark[];
}

export interface TtsProvider {
  readonly id: string;
  voices(): readonly Voice[];
  synthesize(request: SynthesisRequest): Promise<SynthesisResult>;
}
