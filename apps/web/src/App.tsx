import { useCallback, useEffect, useState } from 'react';
import { FolderTree } from './components/FolderTree.js';
import { InstallHint } from './components/InstallHint.js';
import { IngestModal } from './components/IngestModal.js';
import { Library, type LibraryFilter } from './screens/Library.js';
import { Reader } from './screens/Reader.js';
import { SignIn } from './screens/SignIn.js';
import { useSettings } from './state/settings.js';
import { syncChannel } from './api/sync.js';
import { api, onSignedOut, type FolderWithCounts, type PublicUser } from './api/client.js';
import { clearCachedAudio } from './pwa.js';

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
  const [user, setUser] = useState<PublicUser | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [documentId, setDocumentId] = useState<string | null>(documentIdFromPath);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [folderId, setFolderId] = useState<string | null | undefined>(undefined);
  const [folders, setFolders] = useState<FolderWithCounts[]>([]);
  const [unfiled, setUnfiled] = useState(0);
  const [adding, setAdding] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [counts, setCounts] = useState<Record<LibraryFilter, number>>({
    all: 0, recent: 0, bookmarked: 0, inProgress: 0,
  });

  /** Resume an existing session on load, if the cookie is still good. */
  useEffect(() => {
    api.me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setCheckingSession(false));
  }, []);

  /** A 401 from anywhere means the session ended; drop back to sign-in. */
  useEffect(() => onSignedOut(() => setUser(null)), []);

  useEffect(() => {
    if (!user) return;
    syncChannel.connect();
    return () => syncChannel.close();
  }, [user]);

  const reloadFolders = useCallback(() => {
    api.listFolders()
      .then(({ folders: next, unfiled: count }) => { setFolders(next); setUnfiled(count); })
      .catch(() => { /* the library still works without the folder list */ });
  }, []);

  useEffect(() => {
    if (user) reloadFolders();
  }, [user, refreshKey, reloadFolders]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setDocumentId(null);
      setFolders([]);
      // The cached audio is the previous reader's; it must not survive them.
      clearCachedAudio();
      history.pushState(null, '', '/');
    }
  }, []);

  const moveToFolder = useCallback(
    async (docId: string, target: string | null) => {
      try {
        await api.moveToFolder([docId], target);
        setRefreshKey((k) => k + 1);
      } catch { /* the card stays where it was */ }
    },
    [],
  );

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

  if (checkingSession) {
    return <div className="app app--loading"><p className="empty">Opening your library…</p></div>;
  }
  if (!user) {
    return <SignIn onSignedIn={(next) => { setUser(next); setRefreshKey((k) => k + 1); }} />;
  }

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
        <details className="account">
          <summary className="navbar__avatar" aria-label="Account" title={user.email}>
            {(user.displayName || user.email).slice(0, 1).toUpperCase()}
          </summary>
          <div className="account__menu">
            <p className="account__name">{user.displayName}</p>
            <p className="account__email">{user.email}</p>
            <button type="button" className="btn btn--ghost btn--block" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </details>
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
                  aria-current={folderId === undefined && filter === id}
                  onClick={() => { setFilter(id); setFolderId(undefined); }}
                >
                  {label}
                  <span className="sidebar__count">{counts[id]}</span>
                </button>
              ))}
            </div>

            <FolderTree
              folders={folders}
              unfiled={unfiled}
              selected={folderId}
              onSelect={(next) => setFolderId(next)}
              onCreate={(name, parentId) => {
                void api.createFolder(name, parentId).then(reloadFolders).catch(() => undefined);
              }}
              onRename={(id, name) => {
                void api.renameFolder(id, name).then(reloadFolders).catch(() => undefined);
              }}
              onDelete={(id) => {
                void api.deleteFolder(id).then(() => {
                  if (folderId === id) setFolderId(undefined);
                  setRefreshKey((k) => k + 1);
                }).catch(() => undefined);
              }}
              onDropDocument={(docId, target) => void moveToFolder(docId, target)}
            />

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
            <div className="main__hint"><InstallHint /></div>
            <Library
              search={search}
              filter={filter}
              folderId={folderId}
              folders={folders}
              refreshKey={refreshKey}
              onOpen={open}
              onCountsChange={setCounts}
              onMoveToFolder={moveToFolder}
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
