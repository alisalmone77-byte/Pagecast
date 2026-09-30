import { useCallback, useEffect, useState } from 'react';
import { IngestModal } from './components/IngestModal.js';
import { Library, type LibraryFilter } from './screens/Library.js';
import { Reader } from './screens/Reader.js';
import { useSettings } from './state/settings.js';
import { syncChannel } from './api/sync.js';

/**
 * Routing is a single path segment -- `/` for the library, `/d/<id>` for a
 * document -- handled with the History API. A router dependency would be most
 * of a kilobyte for two routes.
 */
function documentIdFromPath(): string | null {
  const match = /^\/d\/([^/]+)/.exec(location.pathname);
  return match?.[1] ?? null;
}

export function App() {
  const { settings, update } = useSettings();
  const [documentId, setDocumentId] = useState<string | null>(documentIdFromPath);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [adding, setAdding] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [counts, setCounts] = useState<Record<LibraryFilter, number>>({
    all: 0, recent: 0, bookmarked: 0, inProgress: 0,
  });

  useEffect(() => {
    syncChannel.connect();
    return () => syncChannel.close();
  }, []);

  useEffect(() => {
    const onPop = () => setDocumentId(documentIdFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const open = useCallback((id: string) => {
    history.pushState(null, '', `/d/${id}`);
    setDocumentId(id);
  }, []);

  const back = useCallback(() => {
    history.pushState(null, '', '/');
    setDocumentId(null);
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <div className="app">
      <nav className="navbar">
        <button type="button" className="navbar__logo" onClick={back}>
          <span className="navbar__mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 14.5Z" />
              <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h4.5a1.5 1.5 0 0 0 1.5-1.5Z" />
            </svg>
          </span>
          Pagecast
        </button>

        {documentId === null ? (
          <div className="navbar__search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search your library"
              aria-label="Search your library"
            />
          </div>
        ) : (
          <div className="navbar__spacer" />
        )}

        <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>
          + Add source
        </button>
        <button type="button" className="navbar__avatar" aria-label="Account">P</button>
      </nav>

      {documentId === null ? (
        <div className="workspace">
          <aside className="sidebar">
            <div className="sidebar__group">
              <p className="sidebar__label">Library</p>
              {([
                ['all', 'All documents'],
                ['inProgress', 'In progress'],
                ['bookmarked', 'Bookmarked'],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className="sidebar__item"
                  aria-current={filter === id}
                  onClick={() => setFilter(id)}
                >
                  {label}
                  <span className="sidebar__count">{counts[id]}</span>
                </button>
              ))}
            </div>

            <div className="sidebar__group">
              <p className="sidebar__label">Appearance</p>
              <div className="sidebar__themes">
                {(['light', 'sepia', 'dark'] as const).map((theme) => (
                  <button
                    key={theme}
                    type="button"
                    className={`theme-swatch theme-swatch--${theme}${settings.theme === theme ? ' theme-swatch--on' : ''}`}
                    onClick={() => update('theme', theme)}
                    aria-label={`${theme} theme`}
                    aria-pressed={settings.theme === theme}
                  />
                ))}
              </div>
            </div>
          </aside>

          <main className="main">
            <Library
              search={search}
              filter={filter}
              refreshKey={refreshKey}
              onOpen={open}
              onCountsChange={setCounts}
            />
          </main>
        </div>
      ) : (
        <div className="workspace workspace--full">
          <Reader
            documentId={documentId}
            settings={settings}
            onBack={back}
            onUpdateSetting={update}
          />
        </div>
      )}

      {adding && (
        <IngestModal
          onClose={() => setAdding(false)}
          onAdded={() => setRefreshKey((k) => k + 1)}
        />
      )}
    </div>
  );
}
