import { useEffect, useMemo, useState } from 'react';
import type { DocumentMeta } from '@pagecast/core';
import { api, type LibraryEntry } from '../api/client.js';
import { formatTime } from '../components/AudioDock.js';

export type LibraryFilter = 'all' | 'recent' | 'bookmarked' | 'inProgress';
export type SortKey = 'recent' | 'progress' | 'title' | 'length';

export interface LibraryProps {
  readonly search: string;
  readonly filter: LibraryFilter;
  readonly refreshKey: number;
  onOpen(id: string): void;
  onCountsChange(counts: Record<LibraryFilter, number>): void;
}

export function Library({ search, filter, refreshKey, onOpen, onCountsChange }: LibraryProps) {
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
  }, [documents, search, filter, sort]);

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
      {continueItem && filter !== 'bookmarked' && !search && (
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
          {filter === 'bookmarked' ? 'Bookmarked' : filter === 'inProgress' ? 'In progress' : 'All documents'}
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
          {search ? `Nothing matches “${search}”.` : 'Nothing here yet — add a PDF, an article link or some text to get started.'}
        </p>
      ) : (
        <div className={view === 'grid' ? 'grid' : 'list'}>
          {visible.map((doc) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              view={view}
              onOpen={() => onOpen(doc.id)}
              onDelete={() => void remove(doc.id)}
              onBookmark={() => void toggleBookmark(doc)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentCard({
  doc, view, onOpen, onDelete, onBookmark,
}: {
  doc: LibraryEntry;
  view: 'grid' | 'list';
  onOpen: () => void;
  onDelete: () => void;
  onBookmark: () => void;
}) {
  const progress = doc.state?.progress ?? 0;
  return (
    <article className={view === 'grid' ? 'card' : 'row'}>
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
