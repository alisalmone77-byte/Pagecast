import type { ReadingPosition, ReadingState } from './types.js';
import { comparePositions } from './position.js';

/**
 * Cross-device hand-off.
 *
 * Two devices can both write reading state while offline, so the merge has to
 * be deterministic and run identically on the server and on both clients.
 * Ordering is by server revision rather than wall-clock time, because a phone
 * that has been in a pocket for an hour can easily have a clock a minute off a
 * laptop's, and a minute is long enough to lose a chapter.
 *
 * When two writes carry the same revision (a genuine concurrent edit, both
 * branching off the same base), the further position wins. That biases towards
 * never re-reading: the worst case is that a reader skips back manually, which
 * is one tap, rather than silently losing progress they already made.
 */

export interface SyncConflict {
  readonly reason: 'revision' | 'position' | 'timestamp' | 'identical';
  readonly winner: 'local' | 'remote';
}

export interface MergeResult {
  readonly state: ReadingState;
  readonly conflict: SyncConflict | null;
}

export function mergeReadingState(local: ReadingState, remote: ReadingState): MergeResult {
  if (local.documentId !== remote.documentId) {
    throw new Error(
      `cannot merge reading state across documents: ${local.documentId} vs ${remote.documentId}`,
    );
  }

  if (remote.rev > local.rev) return { state: remote, conflict: { reason: 'revision', winner: 'remote' } };
  if (local.rev > remote.rev) return { state: local, conflict: { reason: 'revision', winner: 'local' } };

  const byPosition = comparePositions(local.position, remote.position);
  if (byPosition > 0) return { state: local, conflict: { reason: 'position', winner: 'local' } };
  if (byPosition < 0) return { state: remote, conflict: { reason: 'position', winner: 'remote' } };

  // Same revision and same position: only the playback preferences differ, so
  // the most recent write wins and nothing is at stake either way.
  const localTime = Date.parse(local.updatedAt);
  const remoteTime = Date.parse(remote.updatedAt);
  if (Number.isFinite(localTime) && Number.isFinite(remoteTime) && localTime !== remoteTime) {
    return localTime > remoteTime
      ? { state: local, conflict: { reason: 'timestamp', winner: 'local' } }
      : { state: remote, conflict: { reason: 'timestamp', winner: 'remote' } };
  }
  return { state: local, conflict: null };
}

/**
 * Should this position be pushed to the server yet?
 *
 * Writing on every word would be roughly three requests a second. Writing only
 * on pause loses the last stretch if the app is killed or the tab closed. The
 * compromise: push once the reader has covered a meaningful number of words, or
 * once enough time has passed, or whenever playback state changes -- which
 * callers signal with `force` (play, pause, seek, speed or voice change,
 * backgrounding).
 *
 * Positions are given as global word indices so the check is a subtraction and
 * does not need the document content.
 */
export interface PushGate {
  readonly wordIndex: number;
  readonly atMs: number;
}

export interface PushGateOptions {
  readonly minWords?: number;
  readonly minIntervalMs?: number;
  readonly force?: boolean;
}

export function shouldPushPosition(
  last: PushGate | null,
  nextWordIndex: number,
  nowMs: number,
  opts: PushGateOptions = {},
): boolean {
  const { minWords = 25, minIntervalMs = 10_000, force = false } = opts;
  if (force || last === null) return true;
  if (nowMs - last.atMs >= minIntervalMs) return true;
  return Math.abs(nextWordIndex - last.wordIndex) >= minWords;
}

/** A fresh reading state for a document that has never been opened. */
export function initialReadingState(
  documentId: string,
  deviceId: string,
  voiceId: string,
  now: Date = new Date(),
): ReadingState {
  return {
    documentId,
    position: { blockIndex: 0, tokenIndex: 0 },
    progress: 0,
    speed: 1,
    voiceId,
    rev: 0,
    updatedAt: now.toISOString(),
    deviceId,
  };
}
