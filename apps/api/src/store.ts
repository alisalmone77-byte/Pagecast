import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  DocumentContent, DocumentMeta, Highlight, ReadingState, Timeline,
} from '@pagecast/core';
import { initialReadingState, mergeReadingState } from '@pagecast/core';
import { config, paths } from './config.js';
import { HttpError } from './http.js';

/**
 * Persistence.
 *
 * Documents are JSON files on disk, with metadata mirrored in memory so the
 * library listing does not have to read every document to render. That is a
 * deliberate trade for a single-user reading app: it keeps the server free of
 * a database dependency while staying honest about durability -- every write
 * is atomic (write to a temp file, then rename), so a crash mid-write leaves
 * the previous version intact rather than a truncated file.
 *
 * The seam to replace when this needs to be multi-tenant is this module only;
 * nothing above it knows where the bytes live.
 */

export interface StoredDocument {
  readonly meta: DocumentMeta;
  readonly content: DocumentContent;
  /** Original extracted text, kept so a document can be re-parsed after a tokenizer fix. */
  readonly rawText: string;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Write atomically: a crash leaves the old file, never a half-written one. */
async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export class Store {
  private readonly metaCache = new Map<string, DocumentMeta>();
  /** Serialises read-modify-write cycles on reading state, per user+document. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private loaded = false;

  async init(): Promise<void> {
    if (this.loaded) return;
    await ensureDir(paths.documents());
    const files = await fs.readdir(paths.documents()).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const doc = await readJsonFile<StoredDocument>(path.join(paths.documents(), file));
      if (doc?.meta) this.metaCache.set(doc.meta.id, doc.meta);
    }
    this.loaded = true;
    console.log(`[store] ${this.metaCache.size} document(s) in ${config.dataDir}`);
  }

  /* ------------------------------------------------------------ documents */

  listDocuments(): DocumentMeta[] {
    return [...this.metaCache.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getMeta(id: string): DocumentMeta | null {
    return this.metaCache.get(id) ?? null;
  }

  async getDocument(id: string): Promise<StoredDocument> {
    const doc = await readJsonFile<StoredDocument>(paths.document(id));
    if (!doc) throw new HttpError(404, `no document ${id}`);
    return doc;
  }

  async saveDocument(doc: StoredDocument): Promise<StoredDocument> {
    await writeAtomic(paths.document(doc.meta.id), JSON.stringify(doc));
    this.metaCache.set(doc.meta.id, doc.meta);
    return doc;
  }

  async updateMeta(id: string, patch: Partial<DocumentMeta>): Promise<DocumentMeta> {
    const doc = await this.getDocument(id);
    const meta: DocumentMeta = { ...doc.meta, ...patch, id, updatedAt: new Date().toISOString() };
    await this.saveDocument({ ...doc, meta });
    return meta;
  }

  async deleteDocument(id: string): Promise<void> {
    this.metaCache.delete(id);
    await fs.rm(paths.document(id), { force: true });
    await fs.rm(path.join(config.dataDir, 'audio', id), { recursive: true, force: true });
    await fs.rm(path.join(config.dataDir, 'timelines', id), { recursive: true, force: true });
  }

  newDocumentId(): string {
    return randomUUID();
  }

  /* ------------------------------------------------------------ timelines */

  async getTimeline(documentId: string, voiceId: string): Promise<Timeline | null> {
    return readJsonFile<Timeline>(paths.timeline(documentId, voiceId));
  }

  async saveTimeline(documentId: string, timeline: Timeline): Promise<void> {
    await writeAtomic(paths.timeline(documentId, timeline.voiceId), JSON.stringify(timeline));
  }

  async listTimelineVoices(documentId: string): Promise<string[]> {
    const dir = path.join(config.dataDir, 'timelines', documentId);
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  }

  /* ---------------------------------------------------------------- audio */

  async saveAudioChunk(
    documentId: string, voiceId: string, index: number, ext: string, bytes: Buffer,
  ): Promise<string> {
    const file = paths.audioChunk(documentId, voiceId, index, ext);
    await writeAtomic(file, bytes);
    return file;
  }

  async readAudioChunk(
    documentId: string, voiceId: string, index: number, ext: string,
  ): Promise<Buffer | null> {
    try {
      return await fs.readFile(paths.audioChunk(documentId, voiceId, index, ext));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /* -------------------------------------------------------- reading state */

  async getState(userId: string, documentId: string): Promise<ReadingState | null> {
    return readJsonFile<ReadingState>(paths.state(userId, documentId));
  }

  async listStates(userId: string): Promise<ReadingState[]> {
    const dir = paths.stateDir(userId);
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    const out: ReadingState[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const state = await readJsonFile<ReadingState>(path.join(dir, file));
      if (state) out.push(state);
    }
    return out;
  }

  /**
   * Apply an incoming reading state, merging it against whatever is on disk.
   *
   * Runs under a per-document lock: two devices writing at the same moment
   * would otherwise both read rev N and both write rev N+1, silently dropping
   * one of the two updates.
   */
  async applyState(
    userId: string, incoming: ReadingState,
  ): Promise<{ state: ReadingState; changed: boolean }> {
    return this.withLock(`${userId}/${incoming.documentId}`, async () => {
      const current = await this.getState(userId, incoming.documentId);
      if (!current) {
        const state: ReadingState = { ...incoming, rev: 1, updatedAt: new Date().toISOString() };
        await writeAtomic(paths.state(userId, state.documentId), JSON.stringify(state));
        return { state, changed: true };
      }

      // A client sends the revision it believed it was updating. If that still
      // matches, the write is a clean fast-forward and gets the next revision.
      if (incoming.rev >= current.rev) {
        const state: ReadingState = {
          ...incoming,
          rev: current.rev + 1,
          updatedAt: new Date().toISOString(),
        };
        await writeAtomic(paths.state(userId, state.documentId), JSON.stringify(state));
        return { state, changed: true };
      }

      // The client branched from an older revision, so this is a genuine
      // concurrent write rather than a stale one. Its `rev` says which
      // revision it built on, not how authoritative it is, so the revisions
      // are levelled before merging and the tie is resolved on position --
      // otherwise a phone that read half a chapter offline would silently
      // lose all of it to whatever the laptop wrote first.
      const { state: merged } = mergeReadingState(current, { ...incoming, rev: current.rev });
      if (merged === current) return { state: current, changed: false };
      const state: ReadingState = { ...merged, rev: current.rev + 1, updatedAt: new Date().toISOString() };
      await writeAtomic(paths.state(userId, state.documentId), JSON.stringify(state));
      return { state, changed: true };
    });
  }

  async ensureState(userId: string, documentId: string, voiceId: string): Promise<ReadingState> {
    const existing = await this.getState(userId, documentId);
    if (existing) return existing;
    return initialReadingState(documentId, 'server', voiceId);
  }

  /* ----------------------------------------------------------- highlights */

  async listHighlights(userId: string, documentId: string): Promise<Highlight[]> {
    return (await readJsonFile<Highlight[]>(paths.highlights(userId, documentId))) ?? [];
  }

  async saveHighlights(userId: string, documentId: string, highlights: Highlight[]): Promise<void> {
    await writeAtomic(paths.highlights(userId, documentId), JSON.stringify(highlights));
  }

  /* ------------------------------------------------------------ internals */

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Keep the chain alive but never let a rejection poison the next waiter.
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }
}

export const store = new Store();
