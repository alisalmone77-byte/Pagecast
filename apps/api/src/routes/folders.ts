import { randomUUID } from 'node:crypto';
import type { Folder } from '@pagecast/core';
import { HttpError, readJson, sendJson, type Router } from '../http.js';
import { store } from '../store.js';

/**
 * Folders.
 *
 * Nesting is capped at one level below the root on purpose. A reading library
 * is browsed and recognised, not filed: past two levels, finding a document
 * becomes navigation, and the search box is faster than either.
 */

const MAX_DEPTH = 2;

export function registerFolderRoutes(router: Router): void {
  router.get('/api/folders', async (ctx) => {
    const folders = await store.listFolders(ctx.userId);
    const documents = store.listDocuments(ctx.userId);

    // Counts include documents in child folders, so a collapsed parent still
    // tells you how much is inside it.
    const direct = new Map<string, number>();
    for (const doc of documents) {
      if (!doc.folderId) continue;
      direct.set(doc.folderId, (direct.get(doc.folderId) ?? 0) + 1);
    }
    const childrenOf = new Map<string, Folder[]>();
    for (const folder of folders) {
      const key = folder.parentId ?? '';
      const list = childrenOf.get(key);
      if (list) list.push(folder);
      else childrenOf.set(key, [folder]);
    }
    const totalFor = (folder: Folder): number =>
      (direct.get(folder.id) ?? 0)
      + (childrenOf.get(folder.id) ?? []).reduce((sum, child) => sum + totalFor(child), 0);

    sendJson(ctx.res, 200, {
      folders: folders.map((folder) => ({
        ...folder,
        documentCount: direct.get(folder.id) ?? 0,
        totalCount: totalFor(folder),
      })),
      unfiled: documents.filter((d) => !d.folderId).length,
    });
  });

  router.post('/api/folders', async (ctx) => {
    const body = await readJson<{ name?: unknown; parentId?: unknown }>(ctx.req);
    const folders = await store.listFolders(ctx.userId);

    const name = folderName(body.name);
    const parentId = await resolveParent(ctx.userId, body.parentId, folders);

    const siblings = folders.filter((f) => f.parentId === parentId);
    if (siblings.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
      throw new HttpError(409, `a folder called "${name}" is already here`);
    }

    const now = new Date().toISOString();
    const folder: Folder = {
      id: randomUUID(),
      ownerId: ctx.userId,
      name,
      parentId,
      createdAt: now,
      updatedAt: now,
      sortOrder: siblings.reduce((max, f) => Math.max(max, f.sortOrder), -1) + 1,
    };

    await store.saveFolders(ctx.userId, [...folders, folder]);
    sendJson(ctx.res, 201, { folder });
  });

  router.patch('/api/folders/:id', async (ctx) => {
    const id = requireId(ctx.params['id']);
    const body = await readJson<{ name?: unknown; parentId?: unknown; sortOrder?: unknown }>(ctx.req);
    const folders = await store.listFolders(ctx.userId);

    const existing = folders.find((f) => f.id === id);
    if (!existing) throw new HttpError(404, `no folder ${id}`);

    const patch: { name?: string; parentId?: string | null; sortOrder?: number } = {};
    if (body.name !== undefined) patch.name = folderName(body.name);
    if (body.sortOrder !== undefined && Number.isFinite(Number(body.sortOrder))) {
      patch.sortOrder = Number(body.sortOrder);
    }

    if (body.parentId !== undefined) {
      const parentId = await resolveParent(ctx.userId, body.parentId, folders, id);
      // A folder cannot be moved inside itself or its own descendants: that
      // detaches the whole subtree from the root and it disappears from the
      // sidebar with no way back.
      if (parentId !== null && isDescendant(folders, parentId, id)) {
        throw new HttpError(400, 'a folder cannot be moved inside itself');
      }
      patch.parentId = parentId;
    }

    const updated: Folder = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    const siblings = folders.filter((f) => f.parentId === updated.parentId && f.id !== id);
    if (siblings.some((f) => f.name.toLowerCase() === updated.name.toLowerCase())) {
      throw new HttpError(409, `a folder called "${updated.name}" is already here`);
    }

    await store.saveFolders(ctx.userId, folders.map((f) => (f.id === id ? updated : f)));
    sendJson(ctx.res, 200, { folder: updated });
  });

  /**
   * Delete a folder. Documents are never deleted with it -- losing a book
   * because you tidied up a folder is not a recoverable mistake. They move to
   * the deleted folder's parent, as do any child folders.
   */
  router.delete('/api/folders/:id', async (ctx) => {
    const id = requireId(ctx.params['id']);
    const folders = await store.listFolders(ctx.userId);
    const target = folders.find((f) => f.id === id);
    if (!target) throw new HttpError(404, `no folder ${id}`);

    const remaining = folders
      .filter((f) => f.id !== id)
      .map((f) => (f.parentId === id ? { ...f, parentId: target.parentId } : f));
    await store.saveFolders(ctx.userId, remaining);

    let moved = 0;
    for (const meta of store.listDocuments(ctx.userId)) {
      if (meta.folderId !== id) continue;
      await store.updateMeta(meta.id, { folderId: target.parentId }, ctx.userId);
      moved += 1;
    }

    sendJson(ctx.res, 200, { deleted: id, documentsMoved: moved });
  });

  /** Move documents between folders, or out of one entirely. */
  router.post('/api/folders/move', async (ctx) => {
    const body = await readJson<{ documentIds?: unknown; folderId?: unknown }>(ctx.req);
    const ids = Array.isArray(body.documentIds)
      ? body.documentIds.filter((id): id is string => typeof id === 'string')
      : [];
    if (ids.length === 0) throw new HttpError(400, 'documentIds is required');

    let folderId: string | null = null;
    if (typeof body.folderId === 'string' && body.folderId.length > 0) {
      const folders = await store.listFolders(ctx.userId);
      if (!folders.some((f) => f.id === body.folderId)) {
        throw new HttpError(404, `no folder ${body.folderId}`);
      }
      folderId = body.folderId;
    }

    const moved: string[] = [];
    for (const id of ids) {
      // updateMeta enforces ownership, so a foreign id fails rather than moving.
      await store.updateMeta(id, { folderId }, ctx.userId);
      moved.push(id);
    }
    sendJson(ctx.res, 200, { moved, folderId });
  });
}

function folderName(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'a folder name is required');
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length === 0) throw new HttpError(400, 'a folder name cannot be empty');
  return name.slice(0, 80);
}

async function resolveParent(
  ownerId: string, value: unknown, folders: readonly Folder[], movingId?: string,
): Promise<string | null> {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, 'parentId must be a folder id or null');

  const parent = folders.find((f) => f.id === value);
  if (!parent) throw new HttpError(404, `no folder ${value}`);
  if (movingId && parent.id === movingId) throw new HttpError(400, 'a folder cannot contain itself');
  if (depthOf(folders, parent) + 1 >= MAX_DEPTH) {
    throw new HttpError(400, 'folders only nest one level deep');
  }
  void ownerId;
  return parent.id;
}

function depthOf(folders: readonly Folder[], folder: Folder): number {
  let depth = 0;
  let current: Folder | undefined = folder;
  // Bounded by the folder count, so a cycle in stored data terminates.
  while (current?.parentId && depth <= folders.length) {
    current = folders.find((f) => f.id === current!.parentId);
    depth += 1;
  }
  return depth;
}

function isDescendant(folders: readonly Folder[], candidateId: string, ancestorId: string): boolean {
  let current = folders.find((f) => f.id === candidateId);
  let guard = 0;
  while (current && guard <= folders.length) {
    if (current.id === ancestorId) return true;
    if (!current.parentId) return false;
    current = folders.find((f) => f.id === current!.parentId);
    guard += 1;
  }
  return false;
}

function requireId(value: string | undefined): string {
  if (!value) throw new HttpError(400, 'a folder id is required');
  return value;
}
