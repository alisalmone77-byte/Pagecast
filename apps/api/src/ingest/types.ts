import type { SourceKind } from '@pagecast/core';

/** What every extractor returns: plain text plus whatever metadata it found. */
export interface Extracted {
  readonly text: string;
  readonly title?: string;
  readonly author?: string;
  /** Page or chapter count, when the format knows it. */
  readonly pageCount?: number;
}

export interface IngestRequest {
  readonly kind: SourceKind;
  readonly bytes?: Buffer;
  readonly url?: string;
  readonly text?: string;
  readonly filename?: string;
  readonly title?: string;
}
