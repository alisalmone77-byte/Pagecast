import test from 'node:test';
import assert from 'node:assert/strict';
import { initialReadingState, mergeReadingState, shouldPushPosition } from '../dist/index.js';

const base = (over = {}) => ({
  documentId: 'doc1',
  position: { blockIndex: 0, tokenIndex: 0 },
  progress: 0,
  speed: 1,
  voiceId: 'v1',
  rev: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  deviceId: 'laptop',
  ...over,
});

test('a higher revision always wins', () => {
  const local = base({ rev: 2, position: { blockIndex: 1, tokenIndex: 0 } });
  const remote = base({ rev: 5, position: { blockIndex: 0, tokenIndex: 3 }, deviceId: 'phone' });
  const { state, conflict } = mergeReadingState(local, remote);
  assert.equal(state.deviceId, 'phone');
  assert.deepEqual(conflict, { reason: 'revision', winner: 'remote' });
});

test('a stale clock cannot beat a newer revision', () => {
  // The phone's clock is an hour fast but its revision is older.
  const local = base({ rev: 9, updatedAt: '2026-01-01T00:00:00.000Z' });
  const remote = base({ rev: 3, updatedAt: '2026-01-01T01:00:00.000Z', deviceId: 'phone' });
  assert.equal(mergeReadingState(local, remote).state.rev, 9);
});

test('concurrent writes at the same revision resolve to the further position', () => {
  const local = base({ rev: 4, position: { blockIndex: 2, tokenIndex: 0 } });
  const remote = base({ rev: 4, position: { blockIndex: 7, tokenIndex: 1 }, deviceId: 'phone' });
  const { state, conflict } = mergeReadingState(local, remote);
  assert.equal(state.position.blockIndex, 7);
  assert.equal(conflict.reason, 'position');
});

test('identical revision and position fall back to the newer timestamp', () => {
  const local = base({ rev: 4, speed: 1, updatedAt: '2026-01-01T00:00:00.000Z' });
  const remote = base({ rev: 4, speed: 2.5, updatedAt: '2026-01-01T00:05:00.000Z', deviceId: 'phone' });
  const { state, conflict } = mergeReadingState(local, remote);
  assert.equal(state.speed, 2.5);
  assert.equal(conflict.reason, 'timestamp');
});

test('truly identical states report no conflict', () => {
  assert.equal(mergeReadingState(base(), base()).conflict, null);
});

test('merging is symmetric in the position it picks', () => {
  const a = base({ rev: 4, position: { blockIndex: 2, tokenIndex: 5 }, deviceId: 'a' });
  const b = base({ rev: 4, position: { blockIndex: 9, tokenIndex: 1 }, deviceId: 'b' });
  assert.deepEqual(mergeReadingState(a, b).state.position, mergeReadingState(b, a).state.position);
});

test('merging across documents is rejected', () => {
  assert.throws(() => mergeReadingState(base(), base({ documentId: 'other' })), /across documents/);
});

test('the first position is always pushed', () => {
  assert.equal(shouldPushPosition(null, 0, 0), true);
});

test('small movements within the interval are not pushed', () => {
  assert.equal(shouldPushPosition({ wordIndex: 100, atMs: 0 }, 105, 1_000), false);
});

test('a large movement is pushed immediately', () => {
  assert.equal(shouldPushPosition({ wordIndex: 100, atMs: 0 }, 140, 1_000), true);
});

test('the interval forces a push even without movement', () => {
  assert.equal(shouldPushPosition({ wordIndex: 100, atMs: 0 }, 100, 11_000), true);
});

test('force overrides every other condition', () => {
  assert.equal(shouldPushPosition({ wordIndex: 100, atMs: 0 }, 100, 1, { force: true }), true);
});

test('seeking backwards counts as movement', () => {
  assert.equal(shouldPushPosition({ wordIndex: 500, atMs: 0 }, 100, 1_000), true);
});

test('a fresh reading state starts at the top', () => {
  const s = initialReadingState('doc9', 'dev1', 'voice-a');
  assert.deepEqual(s.position, { blockIndex: 0, tokenIndex: 0 });
  assert.equal(s.rev, 0);
  assert.equal(s.progress, 0);
});
