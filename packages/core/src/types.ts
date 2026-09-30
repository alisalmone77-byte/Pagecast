/**
 * Core document + playback model shared by the web app, the API and (mirrored
 * by hand) the iOS client.
 *
 * The central design decision lives here: a reading position is expressed as a
 * (blockIndex, tokenIndex) pair -- never as a number of seconds. Audio duration
 * depends on the voice and the speaking rate, both of which differ per device,
 * so seconds do not survive a hand-off. A word index does. Timelines convert
 * between the two locally, on whichever device is playing.
 */

/** A single word-like run of text inside a block. */
export interface Token {
  /** Index of this token within its block. */
  readonly i: number;
  readonly text: string;
  /** Character offset of the token within `Block.text` (inclusive). */
  readonly start: number;
  /** Character offset one past the end of the token within `Block.text`. */
  readonly end: number;
}

export type BlockType =
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'paragraph'
  | 'quote'
  | 'listItem'
  | 'code';

/** A paragraph-level unit of the document. Blocks are the unit of layout. */
export interface Block {
  readonly index: number;
  readonly type: BlockType;
  readonly text: string;
  readonly tokens: readonly Token[];
}

/**
 * A sentence, addressed as a half-open token range within one block.
 * Sentences never span blocks: a paragraph break always ends a sentence.
 */
export interface Sentence {
  readonly index: number;
  readonly blockIndex: number;
  /** First token index within the block (inclusive). */
  readonly startToken: number;
  /** One past the last token index within the block (exclusive). */
  readonly endToken: number;
}

/** The parsed body of a document: what gets rendered and what gets spoken. */
export interface DocumentContent {
  readonly blocks: readonly Block[];
  readonly sentences: readonly Sentence[];
}

/** Where a reader is, independent of voice and speaking rate. */
export interface ReadingPosition {
  readonly blockIndex: number;
  /** Token index within that block. */
  readonly tokenIndex: number;
}

export type SourceKind = 'pdf' | 'epub' | 'docx' | 'txt' | 'url' | 'scan' | 'paste';

export interface DocumentMeta {
  readonly id: string;
  readonly title: string;
  readonly author?: string;
  readonly sourceKind: SourceKind;
  /** Origin URL for scraped articles, original filename otherwise. */
  readonly sourceRef?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly wordCount: number;
  readonly blockCount: number;
  /** Server-side synthesis state. */
  readonly audioState: AudioState;
  readonly folderId?: string | null;
  readonly bookmarked?: boolean;
}

export type AudioState = 'none' | 'pending' | 'partial' | 'ready' | 'failed';

/* ------------------------------------------------------------------ audio */

/**
 * One synthesised audio file. A document is split into chunks so playback can
 * start before the whole document has been synthesised, and so a client only
 * downloads what it is about to need.
 */
export interface AudioChunk {
  readonly index: number;
  /** Where the chunk begins on the document-wide timeline. */
  readonly startMs: number;
  readonly durationMs: number;
  /** Relative URL the client fetches the audio from. */
  readonly url: string;
  /** Half-open range of sentence indices covered by this chunk. */
  readonly startSentence: number;
  readonly endSentence: number;
}

/** When a word is spoken, on the document-wide timeline. */
export interface WordTiming {
  readonly blockIndex: number;
  readonly tokenIndex: number;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The full map between document positions and media time for one voice.
 * `words` is sorted by startMs and is the array binary-searched at playback.
 */
export interface Timeline {
  readonly voiceId: string;
  readonly durationMs: number;
  readonly chunks: readonly AudioChunk[];
  readonly words: readonly WordTiming[];
  /** Index into `words` of the first word of each sentence. */
  readonly sentenceStarts: readonly number[];
  /** True when the provider supplied real word boundaries rather than estimates. */
  readonly precise: boolean;
}

export interface Voice {
  readonly id: string;
  readonly label: string;
  readonly accent: string;
  readonly gender: 'female' | 'male' | 'neutral';
  readonly provider: string;
  /** Words per minute this voice produces at 1.0x, used to estimate timings. */
  readonly baseWpm: number;
}

/* ------------------------------------------------------- reading state/sync */

/** Per-user, per-document reading state. This is what syncs across devices. */
export interface ReadingState {
  readonly documentId: string;
  readonly position: ReadingPosition;
  /** 0..1, derived from position; stored so the library can render without content. */
  readonly progress: number;
  readonly speed: number;
  readonly voiceId: string;
  /**
   * Monotonic counter incremented by the server on every accepted write.
   * Used instead of wall-clock time to order writes from skewed devices.
   */
  readonly rev: number;
  readonly updatedAt: string;
  /** Which device produced this revision, so a client can ignore its own echo. */
  readonly deviceId: string;
}

export interface Highlight {
  readonly id: string;
  readonly documentId: string;
  readonly blockIndex: number;
  readonly startToken: number;
  readonly endToken: number;
  readonly note?: string;
  readonly color?: string;
  readonly createdAt: string;
}

/** What the reader view needs to paint one frame. */
export interface ActiveSpan {
  readonly wordIndex: number;
  readonly sentenceIndex: number;
  readonly blockIndex: number;
  readonly tokenIndex: number;
  /** 0..1 progress through the current word, for smooth pill animation. */
  readonly wordProgress: number;
}
