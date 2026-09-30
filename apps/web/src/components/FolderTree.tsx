import { useState } from 'react';
import type { FolderWithCounts } from '../api/client.js';

/**
 * The folder sidebar.
 *
 * Folders accept documents dropped onto them, because dragging a card onto a
 * folder is the gesture people already expect and it avoids a modal for what
 * should be one motion.
 */
export interface FolderTreeProps {
  readonly folders: readonly FolderWithCounts[];
  readonly unfiled: number;
  /** A folder id, `null` for Unfiled, or `undefined` when no folder filter is active. */
  readonly selected: string | null | undefined;
  onSelect(folderId: string | null): void;
  onCreate(name: string, parentId: string | null): void;
  onRename(id: string, name: string): void;
  onDelete(id: string): void;
  onDropDocument(documentId: string, folderId: string | null): void;
}

export function FolderTree({
  folders, unfiled, selected, onSelect, onCreate, onRename, onDelete, onDropDocument,
}: FolderTreeProps) {
  const [creatingUnder, setCreatingUnder] = useState<string | null | undefined>(undefined);
  const [draftName, setDraftName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);

  const roots = folders.filter((f) => f.parentId === null);
  const childrenOf = (id: string) => folders.filter((f) => f.parentId === id);

  const submitDraft = (parentId: string | null) => {
    const name = draftName.trim();
    if (name.length > 0) onCreate(name, parentId);
    setDraftName('');
    setCreatingUnder(undefined);
  };

  const dropProps = (folderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget(folderId);
    },
    onDragLeave: () => setDropTarget(undefined),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropTarget(undefined);
      const documentId = e.dataTransfer.getData('application/x-pagecast-document');
      if (documentId) onDropDocument(documentId, folderId);
    },
  });

  const renderFolder = (folder: FolderWithCounts, depth: number) => (
    <div key={folder.id}>
      <div
        className={`sidebar__item sidebar__item--folder${dropTarget === folder.id ? ' sidebar__item--drop' : ''}`}
        style={{ paddingLeft: `calc(var(--space-3) + ${depth * 14}px)` }}
        aria-current={selected === folder.id}
        {...dropProps(folder.id)}
      >
        {renaming === folder.id ? (
          <input
            className="sidebar__rename"
            defaultValue={folder.name}
            autoFocus
            onBlur={(e) => { onRename(folder.id, e.target.value); setRenaming(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { onRename(folder.id, e.currentTarget.value); setRenaming(null); }
              if (e.key === 'Escape') setRenaming(null);
            }}
          />
        ) : (
          <>
            <button type="button" className="sidebar__folder-name" onClick={() => onSelect(folder.id)}>
              <FolderIcon />
              <span>{folder.name}</span>
            </button>
            <span className="sidebar__count">{folder.totalCount}</span>
            <span className="sidebar__folder-actions">
              {depth === 0 && (
                <button
                  type="button"
                  title="New folder inside"
                  aria-label={`New folder inside ${folder.name}`}
                  onClick={() => { setCreatingUnder(folder.id); setDraftName(''); }}
                >+</button>
              )}
              <button
                type="button"
                title="Rename"
                aria-label={`Rename ${folder.name}`}
                onClick={() => setRenaming(folder.id)}
              >✎</button>
              <button
                type="button"
                title="Delete folder"
                aria-label={`Delete ${folder.name}`}
                onClick={() => onDelete(folder.id)}
              >×</button>
            </span>
          </>
        )}
      </div>

      {childrenOf(folder.id).map((child) => renderFolder(child, depth + 1))}

      {creatingUnder === folder.id && (
        <NewFolderInput
          depth={depth + 1}
          value={draftName}
          onChange={setDraftName}
          onSubmit={() => submitDraft(folder.id)}
          onCancel={() => setCreatingUnder(undefined)}
        />
      )}
    </div>
  );

  return (
    <div className="sidebar__group">
      <p className="sidebar__label">
        Folders
        <button
          type="button"
          className="sidebar__add"
          onClick={() => { setCreatingUnder(null); setDraftName(''); }}
          aria-label="New folder"
          title="New folder"
        >+</button>
      </p>

      <div
        className={`sidebar__item${dropTarget === null ? ' sidebar__item--drop' : ''}`}
        aria-current={selected === null}
        {...dropProps(null)}
      >
        <button type="button" className="sidebar__folder-name" onClick={() => onSelect(null)}>
          <span>Unfiled</span>
        </button>
        <span className="sidebar__count">{unfiled}</span>
      </div>

      {roots.map((folder) => renderFolder(folder, 0))}

      {creatingUnder === null && (
        <NewFolderInput
          depth={0}
          value={draftName}
          onChange={setDraftName}
          onSubmit={() => submitDraft(null)}
          onCancel={() => setCreatingUnder(undefined)}
        />
      )}

      {folders.length === 0 && creatingUnder === undefined && (
        <p className="sidebar__empty">No folders yet.</p>
      )}
    </div>
  );
}

function NewFolderInput({
  depth, value, onChange, onSubmit, onCancel,
}: {
  depth: number;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <input
      className="sidebar__rename"
      style={{ marginLeft: `calc(var(--space-3) + ${depth * 14}px)` }}
      value={value}
      autoFocus
      placeholder="Folder name"
      onChange={(e) => onChange(e.target.value)}
      onBlur={onSubmit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSubmit();
        if (e.key === 'Escape') onCancel();
      }}
    />
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}
