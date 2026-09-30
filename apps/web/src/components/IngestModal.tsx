import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentMeta } from '@pagecast/core';
import { api } from '../api/client.js';

/** Drag-and-drop, URL scraping and paste, in one modal. */

type Tab = 'file' | 'url' | 'paste';

export function IngestModal({ onClose, onAdded }: { onClose: () => void; onAdded: (meta: DocumentMeta) => void }) {
  const [tab, setTab] = useState<Tab>('file');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = useCallback(
    async (task: () => Promise<DocumentMeta>) => {
      setBusy(true);
      setError(null);
      try {
        onAdded(await task());
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onAdded, onClose],
  );

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = [...files];
      if (list.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        // Sequential rather than parallel: each upload is followed by parsing,
        // and a dropped folder of PDFs would otherwise saturate the server.
        let last: DocumentMeta | null = null;
        for (const file of list) {
          last = await api.ingestFile(file);
          onAdded(last);
        }
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onAdded, onClose],
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Add a source" ref={dialogRef} tabIndex={-1}>
        <header className="modal__header">
          <h2>Add a source</h2>
          <button type="button" className="btn btn--icon btn--ghost" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="tabs" role="tablist">
          {(['file', 'url', 'paste'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`tabs__tab${tab === id ? ' tabs__tab--on' : ''}`}
              onClick={() => setTab(id)}
            >
              {id === 'file' ? 'Upload' : id === 'url' ? 'Web link' : 'Paste text'}
            </button>
          ))}
        </div>

        <div className="modal__body">
          {tab === 'file' && (
            <div
              className={`dropzone${dragging ? ' dropzone--over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void addFiles(e.dataTransfer.files);
              }}
              onClick={() => fileInput.current?.click()}
            >
              <UploadIcon />
              <p className="dropzone__title">Drop files here, or click to browse</p>
              <p className="dropzone__hint">PDF, EPUB, DOCX and plain text. Several at once is fine.</p>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept=".pdf,.epub,.docx,.txt,.md,application/pdf,application/epub+zip,text/plain"
                className="visually-hidden"
                onChange={(e) => { if (e.target.files) void addFiles(e.target.files); }}
              />
            </div>
          )}

          {tab === 'url' && (
            <form
              className="form"
              onSubmit={(e) => { e.preventDefault(); void run(() => api.ingestUrl(url.trim())); }}
            >
              <label className="field">
                <span>Article URL</span>
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/an-article"
                  required
                  autoFocus
                />
              </label>
              <p className="form__hint">
                The page is fetched and the article extracted; navigation, ads and comments are left behind.
              </p>
              <button type="submit" className="btn btn--primary" disabled={busy || url.trim().length === 0}>
                {busy ? 'Fetching…' : 'Add article'}
              </button>
            </form>
          )}

          {tab === 'paste' && (
            <form
              className="form"
              onSubmit={(e) => { e.preventDefault(); void run(() => api.ingestText(text, title.trim() || undefined)); }}
            >
              <label className="field">
                <span>Title (optional)</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" />
              </label>
              <label className="field">
                <span>Text</span>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={9}
                  placeholder="Paste anything you want read aloud…"
                  required
                  autoFocus
                />
              </label>
              <button type="submit" className="btn btn--primary" disabled={busy || text.trim().length === 0}>
                {busy ? 'Adding…' : 'Add text'}
              </button>
            </form>
          )}

          {busy && tab === 'file' && <p className="modal__status" role="status">Extracting text…</p>}
          {error && <p className="modal__error" role="alert">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function UploadIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M12 4v12" />
    </svg>
  );
}
