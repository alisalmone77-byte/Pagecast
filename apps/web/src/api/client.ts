import type {
  DocumentContent, DocumentMeta, Highlight, ReadingPosition, ReadingState, Timeline, Voice,
} from '@pagecast/core';

/**
 * REST client.
 *
 * Every request carries a device id so the server can avoid echoing a write
 * back to the device that made it, and a user id which a real deployment would
 * replace with a session cookie.
 */

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Stable per-browser device identity, so hand-off can tell devices apart. */
export const deviceId: string = (() => {
  const KEY = 'pagecast.deviceId';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const created = `web-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(KEY, created);
    return created;
  } catch {
    // Private browsing with storage blocked: a per-session id still works.
    return `web-${Math.random().toString(36).slice(2, 10)}`;
  }
})();

export const userId = 'local';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-pagecast-device', deviceId);
  headers.set('x-pagecast-user', userId);
  if (init.body !== undefined && !(init.body instanceof ArrayBuffer) && !ArrayBuffer.isView(init.body)) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `request failed with ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return body as T;
}

/* ------------------------------------------------------------- documents */

export interface LibraryEntry extends DocumentMeta {
  readonly state: ReadingState | null;
}

export interface FullDocument {
  readonly meta: DocumentMeta;
  readonly content: DocumentContent;
  readonly state: ReadingState;
  readonly highlights: Highlight[];
}

export const api = {
  listDocuments: () => request<{ documents: LibraryEntry[] }>('/api/documents').then((r) => r.documents),

  continueListening: (limit = 5) =>
    request<{ documents: LibraryEntry[] }>(`/api/documents/continue?limit=${limit}`).then((r) => r.documents),

  getDocument: (id: string) => request<FullDocument>(`/api/documents/${id}`),

  updateDocument: (id: string, patch: Partial<Pick<DocumentMeta, 'title' | 'folderId' | 'bookmarked'>>) =>
    request<{ meta: DocumentMeta }>(`/api/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then((r) => r.meta),

  deleteDocument: (id: string) => request<{ deleted: string }>(`/api/documents/${id}`, { method: 'DELETE' }),

  /* ------------------------------------------------------------ ingestion */

  ingestFile: async (file: File): Promise<DocumentMeta> => {
    const bytes = await file.arrayBuffer();
    const result = await request<{ meta: DocumentMeta }>('/api/ingest/file', {
      method: 'POST',
      // Percent-encoded so non-ASCII filenames survive the header.
      headers: { 'x-pagecast-filename': encodeURIComponent(file.name) },
      body: bytes,
    });
    return result.meta;
  },

  ingestUrl: (url: string) =>
    request<{ meta: DocumentMeta }>('/api/ingest/url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }).then((r) => r.meta),

  ingestText: (text: string, title?: string) =>
    request<{ meta: DocumentMeta }>('/api/ingest/text', {
      method: 'POST',
      body: JSON.stringify({ text, title }),
    }).then((r) => r.meta),

  /* ---------------------------------------------------------------- audio */

  listVoices: () => request<{ voices: Voice[] }>('/api/voices').then((r) => r.voices),

  startSynthesis: (id: string, voiceId: string) =>
    request<{ timeline: Timeline | null; state: string }>(`/api/documents/${id}/audio`, {
      method: 'POST',
      body: JSON.stringify({ voiceId }),
    }),

  getTimeline: (id: string, voiceId: string) =>
    request<{ timeline: Timeline | null; done: number; total: number; error: string | null }>(
      `/api/documents/${id}/timeline?voiceId=${encodeURIComponent(voiceId)}`,
    ),

  /* ----------------------------------------------------------------- sync */

  putState: (id: string, body: { position: ReadingPosition; speed: number; voiceId: string; rev: number }) =>
    request<{ state: ReadingState; accepted: boolean }>(`/api/sync/state/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...body, deviceId }),
    }),

  getState: (id: string) => request<{ state: ReadingState }>(`/api/sync/state/${id}`).then((r) => r.state),

  /* ----------------------------------------------------------- highlights */

  addHighlight: (id: string, body: { blockIndex: number; startToken: number; endToken: number; note?: string }) =>
    request<{ highlight: Highlight }>(`/api/documents/${id}/highlights`, {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((r) => r.highlight),

  deleteHighlight: (id: string, highlightId: string) =>
    request<{ deleted: string }>(`/api/documents/${id}/highlights/${highlightId}`, { method: 'DELETE' }),
};
