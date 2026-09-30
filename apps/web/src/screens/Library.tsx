import { useEffect, useMemo, useState } from 'react';
import type { DocumentMeta } from '@pagecast/core';
import { api, type FolderWithCounts, type LibraryEntry } from '../api/client.js';
import { formatTime } from '../components/AudioDock.js';

export type LibraryFilter = 'all' | 'recent' | 'bookmarked' | 'inProgress';
export type SortKey = 'recent' | 'progress' | 'title' | 'length';

export interface LibraryProps {
  readonly search: string;
  readonly filter: LibraryFilter;
  /** A folder id, `null` for Unfiled, or `undefined` for no folder filter. */
  readonly folderId: string | null | undefined;
  readonly folders: readonly FolderWithCounts[];
  readonly refreshKey: number;
  onOpen(id: string): void;
  onCountsChange(counts: Record<LibraryFilter, number>): void;
  onMoveToFolder(documentId: string, folderId: string | null): void;
}

export function Library({
  search, filter, folderId, folders, refreshKey, onOpen, onCountsChange, onMoveToFolder,
}: LibraryProps) {
  const [documents, setDocuments] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('recent');
  const [view, setView] = useState<'grid' | 'list'>('grid');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.listDocuments()
      .then((docs) => { if (!cancelled) { setDocuments(docs); setError(null); } })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  useEffect(() => {
    onCountsChange({
      all: documents.length,
      recent: documents.length,
      bookmarked: documents.filter((d) => d.bookmarked).length,
      inProgress: documents.filter((d) => (d.state?.progress ?? 0) > 0.005 && (d.state?.progress ?? 0) < 0.995).length,
    });
  }, [documents, onCountsChange]);

  const continueItem = useMemo(
    () =>
      documents
        .filter((d) => (d.state?.progress ?? 0) > 0.005 && (d.state?.progress ?? 0) < 0.995)
        .sort((a, b) => (b.state?.updatedAt ?? '').localeCompare(a.state?.updatedAt ?? ''))[0] ?? null,
    [documents],
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    let list = documents.filter((doc) => {
      if (needle && !`${doc.title} ${doc.author ?? ''}`.toLowerCase().includes(needle)) return false;
      // A selected folder wins over the filter chips: `null` means Unfiled,
      // `undefined` means no folder filter at all.
      if (folderId !== undefined && (doc.folderId ?? null) !== folderId) return false;
      const progress = doc.state?.progress ?? 0;
      if (filter === 'bookmarked') return doc.bookmarked === true;
      if (filter === 'inProgress') return progress > 0.005 && progress < 0.995;
      return true;
    });

    list = [...list].sort((a, b) => {
      switch (sort) {
        case 'title': return a.title.localeCompare(b.title);
        case 'progress': return (b.state?.progress ?? 0) - (a.state?.progress ?? 0);
        case 'length': return b.wordCount - a.wordCount;
        default: return b.updatedAt.localeCompare(a.updatedAt);
      }
    });
    return list;
  }, [documents, search, filter, folderId, sort]);

  const remove = async (id: string) => {
    const previous = documents;
    setDocuments((docs) => docs.filter((d) => d.id !== id));
    try {
      await api.deleteDocument(id);
    } catch {
      setDocuments(previous);
    }
  };

  const toggleBookmark = async (doc: LibraryEntry) => {
    const next = !doc.bookmarked;
    setDocuments((docs) => docs.map((d) => (d.id === doc.id ? { ...d, bookmarked: next } : d)));
    try {
      await api.updateDocument(doc.id, { bookmarked: next });
    } catch {
      setDocuments((docs) => docs.map((d) => (d.id === doc.id ? { ...d, bookmarked: !next } : d)));
    }
  };

  if (loading) return <div className="library"><SkeletonGrid /></div>;
  if (error) return <div className="library"><p className="empty" role="alert">{error}</p></div>;

  return (
    <div className="library">
      {continueItem && filter !== 'bookmarked' && folderId === undefined && !search && (
        <section className="hero">
          <p className="hero__eyebrow">Continue listening</p>
          <h2 className="hero__title">{continueItem.title}</h2>
          <p className="hero__meta">
            {Math.round((continueItem.state?.progress ?? 0) * 100)}% · {estimateRemaining(continueItem)} left
          </p>
          <div className="hero__bar"><span style={{ width: `${(continueItem.state?.progress ?? 0) * 100}%` }} /></div>
          <button type="button" className="btn btn--primary" onClick={() => onOpen(continueItem.id)}>
            Resume
          </button>
        </section>
      )}

      <div className="library__toolbar">
        <h2 className="library__heading">
          {folderId === undefined
            ? (filter === 'bookmarked' ? 'Bookmarked' : filter === 'inProgress' ? 'In progress' : 'All documents')
            : folderId === null
              ? 'Unfiled'
              : folders.find((f) => f.id === folderId)?.name ?? 'Folder'}
          <span className="library__count">{visible.length}</span>
        </h2>
        <div className="library__controls">
          <label className="select">
            <span className="visually-hidden">Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="recent">Recently updated</option>
              <option value="progress">Progress</option>
              <option value="title">Title</option>
              <option value="length">Length</option>
            </select>
          </label>
          <div className="segmented" role="group" aria-label="View">
            <button type="button" className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} aria-label="Grid view">▦</button>
            <button type="button" className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} aria-label="List view">☰</button>
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="empty">
          {search
            ? `Nothing matches “${search}”.`
            : folderId !== undefined
              ? 'This folder is empty. Drag a document onto it in the sidebar, or use the folder button on a card.'
              : 'Nothing here yet — add a PDF, an article link or some text to get started.'}
        </p>
      ) : (
        <div className={view === 'grid' ? 'grid' : 'list'}>
          {visible.map((doc) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              view={view}
              folders={folders}
              onOpen={() => onOpen(doc.id)}
              onDelete={() => void remove(doc.id)}
              onBookmark={() => void toggleBookmark(doc)}
              onMoveToFolder={(target) => onMoveToFolder(doc.id, target)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentCard({
  doc, view, folders, onOpen, onDelete, onBookmark, onMoveToFolder,
}: {
  doc: LibraryEntry;
  view: 'grid' | 'list';
  folders: readonly FolderWithCounts[];
  onOpen: () => void;
  onDelete: () => void;
  onBookmark: () => void;
  onMoveToFolder: (folderId: string | null) => void;
}) {
  const progress = doc.state?.progress ?? 0;
  return (
    <article
      className={view === 'grid' ? 'card' : 'row'}
      draggable
      // Dragging a card onto a folder is the gesture people already expect,
      // and it avoids a modal for what should be one motion.
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-pagecast-document', doc.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <button type="button" className="card__main" onClick={onOpen}>
        <span className={`badge badge--${doc.sourceKind}`}>{labelFor(doc)}</span>
        <h3 className="card__title">{doc.title}</h3>
        {doc.author && <p className="card__author">{doc.author}</p>}
        <p className="card__meta">
          {doc.wordCount.toLocaleString()} words · {estimateRemaining(doc)}
          {doc.audioState === 'ready' && <span className="card__ready" title="Audio ready"> · ♪</span>}
        </p>
        {progress > 0 && (
          <span className="card__progress"><span style={{ width: `${progress * 100}%` }} /></span>
        )}
      </button>
      <div className="card__actions">
        {folders.length > 0 && (
          <label className="card__folder">
            <span className="visually-hidden">Move {doc.title} to a folder</span>
            <select
              value={doc.folderId ?? ''}
              onChange={(e) => onMoveToFolder(e.target.value === '' ? null : e.target.value)}
            >
              <option value="">Unfiled</option>
              {orderedForPicker(folders).map(({ folder, depth }) => (
                <option key={folder.id} value={folder.id}>
                  {depth > 0 ? `— ${folder.name}` : folder.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="btn btn--icon btn--ghost"
          onClick={onBookmark}
          aria-label={doc.bookmarked ? 'Remove bookmark' : 'Bookmark'}
          aria-pressed={doc.bookmarked === true}
        >
          {doc.bookmarked ? '★' : '☆'}
        </button>
        <button type="button" className="btn btn--icon btn--ghost btn--danger" onClick={onDelete} aria-label={`Delete ${doc.title}`}>
          ×
        </button>
      </div>
    </article>
  );
}

function labelFor(doc: DocumentMeta): string {
  switch (doc.sourceKind) {
    case 'pdf': return 'PDF';
    case 'epub': return 'EPUB';
    case 'docx': return 'DOCX';
    case 'url': return 'Article';
    case 'scan': return 'Scan';
    case 'paste': return 'Text';
    default: return 'Text';
  }
}

/** Remaining listening time at 1x, from the word count and words already read. */
function estimateRemaining(doc: LibraryEntry): string {
  const readWords = doc.wordCount * (doc.state?.progress ?? 0);
  const minutes = ((doc.wordCount - readWords) / 165) * 60;
  return formatTime(minutes * 1000);
}

function SkeletonGrid() {
  return (
    <div className="grid" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => <div key={i} className="card card--skeleton" />)}
    </div>
  );
}

/**
 * Flatten folders for a `<select>`, each parent immediately followed by its own
 * children. The server returns one sorted list, so a child can sort ahead of
 * its parent -- which leaves the indent pointing at nothing and reads as though
 * the nesting is wrong.
 */
function orderedForPicker(
  folders: readonly FolderWithCounts[],
): Array<{ folder: FolderWithCounts; depth: number }> {
  const out: Array<{ folder: FolderWithCounts; depth: number }> = [];
  const childrenOf = (parentId: string | null) => folders.filter((f) => f.parentId === parentId);

  const walk = (parentId: string | null, depth: number) => {
    for (const folder of childrenOf(parentId)) {
      out.push({ folder, depth });
      // One level of nesting is all the server allows, so this cannot run away.
      if (depth === 0) walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
