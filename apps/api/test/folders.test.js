import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pagecast-folders-'));
process.env.PAGECAST_DATA_DIR = dataDir;
process.env.PAGECAST_TTS_PROVIDER = 'local';

const { createServer } = await import('../dist/server.js');
const { store } = await import('../dist/store.js');
const { startServer } = await import('./helpers.js');

let base;
let stop;
let token;
let strangerToken;

before(async () => {
  await store.init();
  ({ base, stop } = await startServer(createServer));
  token = await register('owner@example.com');
  strangerToken = await register('stranger@example.com');
});

after(async () => {
  await stop?.();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function register(email) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'a decent long passphrase' }),
  });
  return (await res.json()).token;
}

async function api(method, route, body, as = token) {
  const init = { method, headers: { authorization: `Bearer ${as}` } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${base}${route}`, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json };
}

async function addDocument(title) {
  const res = await api('POST', '/api/ingest/text', {
    title, text: 'One two three.\n\nFour five six.',
  });
  assert.equal(res.status, 201);
  return res.json.meta;
}

test('a new account starts with no folders', async () => {
  const res = await api('GET', '/api/folders');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.folders, []);
});

test('folders are created and listed', async () => {
  const created = await api('POST', '/api/folders', { name: '  Research  ' });
  assert.equal(created.status, 201);
  assert.equal(created.json.folder.name, 'Research', 'the name should be trimmed');
  assert.equal(created.json.folder.parentId, null);

  const listed = await api('GET', '/api/folders');
  assert.ok(listed.json.folders.some((f) => f.name === 'Research'));
});

test('an empty folder name is refused', async () => {
  assert.equal((await api('POST', '/api/folders', { name: '   ' })).status, 400);
  assert.equal((await api('POST', '/api/folders', {})).status, 400);
});

test('two folders in the same place cannot share a name', async () => {
  await api('POST', '/api/folders', { name: 'Papers' });
  const again = await api('POST', '/api/folders', { name: 'papers' });
  assert.equal(again.status, 409, 'the comparison should ignore case');
});

test('folders nest one level and no further', async () => {
  const parent = (await api('POST', '/api/folders', { name: 'Books' })).json.folder;
  const child = await api('POST', '/api/folders', { name: 'Fiction', parentId: parent.id });
  assert.equal(child.status, 201);
  assert.equal(child.json.folder.parentId, parent.id);

  const grandchild = await api('POST', '/api/folders', { name: 'Sci-Fi', parentId: child.json.folder.id });
  assert.equal(grandchild.status, 400, 'a third level should be refused');
});

test('a child may share a name with a folder elsewhere', async () => {
  const a = (await api('POST', '/api/folders', { name: 'Shelf A' })).json.folder;
  const b = (await api('POST', '/api/folders', { name: 'Shelf B' })).json.folder;
  assert.equal((await api('POST', '/api/folders', { name: 'Unread', parentId: a.id })).status, 201);
  assert.equal((await api('POST', '/api/folders', { name: 'Unread', parentId: b.id })).status, 201);
});

test('a folder under one that does not exist is refused', async () => {
  assert.equal((await api('POST', '/api/folders', { name: 'Orphan', parentId: 'nope' })).status, 404);
});

test('folders can be renamed', async () => {
  const folder = (await api('POST', '/api/folders', { name: 'Old Name' })).json.folder;
  const renamed = await api('PATCH', `/api/folders/${folder.id}`, { name: 'New Name' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.folder.name, 'New Name');
  assert.equal(renamed.json.folder.id, folder.id, 'renaming must not change identity');
});

test('a folder cannot be moved inside itself or its own child', async () => {
  const parent = (await api('POST', '/api/folders', { name: 'Loop Parent' })).json.folder;
  const child = (await api('POST', '/api/folders', { name: 'Loop Child', parentId: parent.id })).json.folder;

  assert.equal((await api('PATCH', `/api/folders/${parent.id}`, { parentId: parent.id })).status, 400);
  // This is the one that would detach the whole subtree from the root.
  assert.equal((await api('PATCH', `/api/folders/${parent.id}`, { parentId: child.id })).status, 400);
});

test('documents move into and out of folders', async () => {
  const folder = (await api('POST', '/api/folders', { name: 'Inbox' })).json.folder;
  const a = await addDocument('Doc A');
  const b = await addDocument('Doc B');

  const moved = await api('POST', '/api/folders/move', { documentIds: [a.id, b.id], folderId: folder.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.moved.length, 2);

  const listed = await api('GET', '/api/documents');
  const stored = listed.json.documents.filter((d) => d.id === a.id || d.id === b.id);
  assert.ok(stored.every((d) => d.folderId === folder.id));

  const out = await api('POST', '/api/folders/move', { documentIds: [a.id], folderId: null });
  assert.equal(out.status, 200);
  const after = await api('GET', '/api/documents');
  assert.equal(after.json.documents.find((d) => d.id === a.id).folderId, null);
});

test('counts include documents nested inside child folders', async () => {
  const parent = (await api('POST', '/api/folders', { name: 'Counted' })).json.folder;
  const child = (await api('POST', '/api/folders', { name: 'Nested', parentId: parent.id })).json.folder;

  const direct = await addDocument('Directly in parent');
  const nested = await addDocument('In the child');
  await api('POST', '/api/folders/move', { documentIds: [direct.id], folderId: parent.id });
  await api('POST', '/api/folders/move', { documentIds: [nested.id], folderId: child.id });

  const listed = await api('GET', '/api/folders');
  const found = listed.json.folders.find((f) => f.id === parent.id);
  assert.equal(found.documentCount, 1, 'documentCount is what is directly inside');
  assert.equal(found.totalCount, 2, 'totalCount includes the child folder');
});

test('deleting a folder keeps its documents and promotes its children', async () => {
  const parent = (await api('POST', '/api/folders', { name: 'Doomed Parent' })).json.folder;
  const child = (await api('POST', '/api/folders', { name: 'Surviving Child', parentId: parent.id })).json.folder;
  const doc = await addDocument('Must Survive');
  await api('POST', '/api/folders/move', { documentIds: [doc.id], folderId: parent.id });

  const deleted = await api('DELETE', `/api/folders/${parent.id}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.documentsMoved, 1);

  // Losing a book because you tidied a folder is not a recoverable mistake.
  const documents = await api('GET', '/api/documents');
  const survivor = documents.json.documents.find((d) => d.id === doc.id);
  assert.ok(survivor, 'the document must still exist');
  assert.equal(survivor.folderId, null, 'and should have moved to the parent of what was deleted');

  const folders = await api('GET', '/api/folders');
  const promoted = folders.json.folders.find((f) => f.id === child.id);
  assert.ok(promoted, 'the child folder must survive');
  assert.equal(promoted.parentId, null);
});

test('deleting a folder that does not exist is a 404', async () => {
  assert.equal((await api('DELETE', '/api/folders/missing')).status, 404);
});

test('folders are private to their account', async () => {
  const mine = (await api('POST', '/api/folders', { name: 'Mine Only' })).json.folder;

  const theirs = await api('GET', '/api/folders', undefined, strangerToken);
  assert.ok(!theirs.json.folders.some((f) => f.id === mine.id));

  assert.equal((await api('PATCH', `/api/folders/${mine.id}`, { name: 'Hijacked' }, strangerToken)).status, 404);
  assert.equal((await api('DELETE', `/api/folders/${mine.id}`, undefined, strangerToken)).status, 404);
});

test('a document cannot be moved into another account folder', async () => {
  const doc = await addDocument('Stay Put');
  const theirFolder = (await api('POST', '/api/folders', { name: 'Their Folder' }, strangerToken)).json.folder;
  assert.equal((await api('POST', '/api/folders/move',
    { documentIds: [doc.id], folderId: theirFolder.id })).status, 404);
});

test('another account cannot move your documents', async () => {
  const doc = await addDocument('Not Yours');
  const theirFolder = (await api('POST', '/api/folders', { name: 'Grabby' }, strangerToken)).json.folder;
  assert.equal((await api('POST', '/api/folders/move',
    { documentIds: [doc.id], folderId: theirFolder.id }, strangerToken)).status, 404);
});

test('moving with no document ids is refused', async () => {
  assert.equal((await api('POST', '/api/folders/move', { documentIds: [] })).status, 400);
  assert.equal((await api('POST', '/api/folders/move', {})).status, 400);
});
