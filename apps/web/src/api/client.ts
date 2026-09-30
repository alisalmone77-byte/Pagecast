import type {
  DocumentContent, DocumentMeta, Folder, Highlight, ReadingPosition, ReadingState, Timeline, Voice,
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

export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: string;
}

export interface AuthConfig {
  readonly allowRegistration: boolean;
  readonly requiresInvite: boolean;
  readonly hasAccounts: boolean;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-pagecast-device', deviceId);
  if (init.body !== undefined && !(init.body instanceof ArrayBuffer) && !ArrayBuffer.isView(init.body)) {
    headers.set('content-type', 'application/json');
  }

  // The session rides in an HttpOnly cookie, which the dev server proxies from
  // a different origin, so credentials have to be sent explicitly.
  const response = await fetch(path, { ...init, headers, credentials: 'include' });
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
    // A 401 anywhere means the session ended -- expired, or signed out from
    // another device. Tell the app once rather than letting every in-flight
    // request surface its own error.
    if (response.status === 401) notifySignedOut();
    throw new ApiError(response.status, message);
  }
  return body as T;
}

/* --------------------------------------------------------- session events */

type SignedOutListener = () => void;
const signedOutListeners = new Set<SignedOutListener>();

export function onSignedOut(listener: SignedOutListener): () => void {
  signedOutListeners.add(listener);
  return () => signedOutListeners.delete(listener);
}

function notifySignedOut(): void {
  for (const listener of signedOutListeners) listener();
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

export interface FolderWithCounts extends Folder {
  readonly documentCount: number;
  readonly totalCount: number;
}

export const api = {
  /* ----------------------------------------------------------------- auth */

  authConfig: () => request<AuthConfig>('/api/auth/config'),

  me: () => request<{ user: PublicUser }>('/api/auth/me').then((r) => r.user),

  register: (body: { email: string; password: string; displayName?: string; inviteCode?: string }) =>
    request<{ user: PublicUser }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((r) => r.user),

  login: (body: { email: string; password: string }) =>
    request<{ user: PublicUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((r) => r.user),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  /* -------------------------------------------------------------- folders */

  listFolders: () =>
    request<{ folders: FolderWithCounts[]; unfiled: number }>('/api/folders'),

  createFolder: (name: string, parentId: string | null = null) =>
    request<{ folder: Folder }>('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ name, parentId }),
    }).then((r) => r.folder),

  renameFolder: (id: string, name: string) =>
    request<{ folder: Folder }>(`/api/folders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }).then((r) => r.folder),

  deleteFolder: (id: string) =>
    request<{ deleted: string; documentsMoved: number }>(`/api/folders/${id}`, { method: 'DELETE' }),

  moveToFolder: (documentIds: string[], folderId: string | null) =>
    request<{ moved: string[] }>('/api/folders/move', {
      method: 'POST',
      body: JSON.stringify({ documentIds, folderId }),
    }),

  /* ------------------------------------------------------------ documents */

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
