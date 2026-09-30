import type { ReadingState } from '@pagecast/core';
import { deviceId } from './client.js';

/**
 * Live sync channel.
 *
 * Purely a push channel: every change is also written over REST, so losing the
 * socket costs live updates and nothing else. It reconnects with exponential
 * backoff and jitter -- without jitter, every open tab reconnects on the same
 * tick after a server restart and knocks it over again.
 */

type StateListener = (state: ReadingState, originDeviceId: string) => void;
type SynthesisListener = (documentId: string, done: number, total: number) => void;

const MAX_BACKOFF_MS = 30_000;

export class SyncChannel {
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private closed = false;
  private readonly subscriptions = new Set<string>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly synthesisListeners = new Set<SynthesisListener>();

  connect(): void {
    if (this.socket || this.closed) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // No user id in the query: the server authenticates the upgrade from the
    // session cookie, which the browser attaches to the handshake for us.
    const url = `${protocol}//${location.host}/api/sync/ws?device=${encodeURIComponent(deviceId)}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      if (this.subscriptions.size > 0) {
        this.send({ type: 'subscribe', documentIds: [...this.subscriptions] });
      }
    });

    socket.addEventListener('message', (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      const payload = message as Record<string, unknown>;

      if (payload['type'] === 'state' && payload['state']) {
        const state = payload['state'] as ReadingState;
        const origin = String(payload['originDeviceId'] ?? '');
        // The server already filters these, but a client-side guard means a
        // stale socket can never make a device fight with itself.
        if (origin === deviceId) return;
        for (const listener of this.stateListeners) listener(state, origin);
      } else if (payload['type'] === 'synthesis') {
        for (const listener of this.synthesisListeners) {
          listener(String(payload['documentId']), Number(payload['done']), Number(payload['total']));
        }
      }
    });

    const onGone = () => {
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    };
    socket.addEventListener('close', onGone);
    socket.addEventListener('error', onGone);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  subscribe(documentId: string): void {
    this.subscriptions.add(documentId);
    this.send({ type: 'subscribe', documentIds: [documentId] });
  }

  unsubscribe(documentId: string): void {
    this.subscriptions.delete(documentId);
    this.send({ type: 'unsubscribe', documentIds: [documentId] });
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onSynthesis(listener: SynthesisListener): () => void {
    this.synthesisListeners.add(listener);
    return () => this.synthesisListeners.delete(listener);
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.reconnectAttempt);
    // Jitter, so a server restart does not bring every tab back at once.
    const delay = base * (0.5 + Math.random() * 0.5);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export const syncChannel = new SyncChannel();
