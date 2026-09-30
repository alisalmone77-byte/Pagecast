import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ReadingState } from '@pagecast/core';

/**
 * A small WebSocket server for live reading-state hand-off.
 *
 * Only the server half of RFC 6455 is implemented, and only what this protocol
 * needs: text frames, ping/pong, and close. That is a deliberate trade -- the
 * payloads here are a few hundred bytes of JSON a few times a minute, so
 * fragmentation and compression would be complexity with nothing to show for
 * it, and it keeps the server dependency-free.
 *
 * Transport is a push channel only. Every state change is also written over
 * REST, so a client that cannot hold a socket open -- a backgrounded phone,
 * a locked-down network -- loses live updates but never loses data.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Opcodes used here; the rest are rejected. */
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Refuse anything larger than a reading-state payload could plausibly be. */
const MAX_MESSAGE_BYTES = 256 * 1024;
const PING_INTERVAL_MS = 30_000;

export type ServerMessage =
  | { type: 'hello'; deviceId: string; documentIds: string[] }
  | { type: 'state'; state: ReadingState; originDeviceId: string }
  | { type: 'synthesis'; documentId: string; voiceId: string; done: number; total: number }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'subscribe'; documentIds: string[] }
  | { type: 'unsubscribe'; documentIds: string[] }
  | { type: 'ping' };

interface Client {
  readonly socket: Duplex;
  readonly userId: string;
  readonly deviceId: string;
  /** Empty means "every document this user has". */
  documentIds: Set<string>;
  alive: boolean;
  buffer: Buffer;
}

export class SyncHub {
  private readonly clients = new Set<Client>();
  private heartbeat: NodeJS.Timeout | null = null;

  /**
   * Complete the HTTP upgrade handshake and adopt the socket.
   *
   * `userId` comes from the caller, which has already resolved the session.
   * It is never read from the query string: this channel carries one reader's
   * positions to their other devices, and a client-supplied identity would let
   * anyone subscribe to anyone.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, userId: string): void {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || (req.headers['upgrade'] ?? '').toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // Position updates are small and latency-sensitive: do not wait on Nagle.
    if ('setNoDelay' in socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);

    const url = new URL(req.url ?? '/', 'http://localhost');
    const client: Client = {
      socket,
      userId,
      deviceId: url.searchParams.get('device') ?? 'unknown',
      documentIds: new Set(),
      alive: true,
      buffer: head.length > 0 ? Buffer.from(head) : Buffer.alloc(0),
    };
    this.clients.add(client);

    socket.on('data', (chunk: Buffer) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      try {
        this.drain(client);
      } catch (err) {
        console.warn('[ws] protocol error:', err instanceof Error ? err.message : err);
        this.drop(client, 1002);
      }
    });
    socket.on('error', () => this.drop(client));
    socket.on('close', () => this.drop(client));

    this.send(client, { type: 'hello', deviceId: client.deviceId, documentIds: [] });
    this.startHeartbeat();
  }

  /** Push a reading-state change to every other device of the same user. */
  broadcastState(userId: string, state: ReadingState, originDeviceId: string): void {
    for (const client of this.clients) {
      if (client.userId !== userId) continue;
      // Do not echo a device's own write back to it.
      if (client.deviceId === originDeviceId) continue;
      if (client.documentIds.size > 0 && !client.documentIds.has(state.documentId)) continue;
      this.send(client, { type: 'state', state, originDeviceId });
    }
  }

  broadcastSynthesis(userId: string, documentId: string, voiceId: string, done: number, total: number): void {
    for (const client of this.clients) {
      if (client.userId !== userId) continue;
      if (client.documentIds.size > 0 && !client.documentIds.has(documentId)) continue;
      this.send(client, { type: 'synthesis', documentId, voiceId, done, total });
    }
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of [...this.clients]) this.drop(client, 1001);
  }

  /* --------------------------------------------------------------- frames */

  private drain(client: Client): void {
    for (;;) {
      const frame = decodeFrame(client.buffer);
      if (!frame) return;
      client.buffer = client.buffer.subarray(frame.consumed);

      switch (frame.opcode) {
        case OP_TEXT:
        case OP_CONTINUATION:
          this.onMessage(client, frame.payload.toString('utf8'));
          break;
        case OP_PING:
          client.socket.write(encodeFrame(OP_PONG, frame.payload));
          break;
        case OP_PONG:
          client.alive = true;
          break;
        case OP_CLOSE:
          this.drop(client, 1000);
          return;
        case OP_BINARY:
          // Nothing in this protocol is binary; treat it as a client error.
          this.drop(client, 1003);
          return;
        default:
          this.drop(client, 1002);
          return;
      }
    }
  }

  private onMessage(client: Client, raw: string): void {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(client, { type: 'error', message: 'message was not valid JSON' });
      return;
    }

    switch (message.type) {
      case 'subscribe':
        for (const id of message.documentIds ?? []) client.documentIds.add(id);
        this.send(client, { type: 'hello', deviceId: client.deviceId, documentIds: [...client.documentIds] });
        break;
      case 'unsubscribe':
        for (const id of message.documentIds ?? []) client.documentIds.delete(id);
        break;
      case 'ping':
        client.alive = true;
        break;
      default:
        this.send(client, { type: 'error', message: `unknown message type` });
    }
  }

  private send(client: Client, message: ServerMessage): void {
    if (client.socket.destroyed) return;
    try {
      client.socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify(message), 'utf8')));
    } catch {
      this.drop(client);
    }
  }

  private drop(client: Client, code?: number): void {
    if (!this.clients.delete(client)) return;
    try {
      if (code !== undefined && !client.socket.destroyed) {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code, 0);
        client.socket.write(encodeFrame(OP_CLOSE, payload));
      }
    } catch { /* the socket is already gone */ }
    client.socket.destroy();
    if (this.clients.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /** Drop sockets that stop answering pings, so dead phones do not accumulate. */
  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const client of [...this.clients]) {
        if (!client.alive) {
          this.drop(client, 1001);
          continue;
        }
        client.alive = false;
        try {
          client.socket.write(encodeFrame(OP_PING, Buffer.alloc(0)));
        } catch {
          this.drop(client);
        }
      }
    }, PING_INTERVAL_MS);
    this.heartbeat.unref();
  }
}

interface DecodedFrame {
  opcode: number;
  payload: Buffer;
  consumed: number;
}

/** Decode one frame, or null when the buffer does not hold a whole one yet. */
export function decodeFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length < 2) return null;

  const first = buf[0]!;
  const second = buf[1]!;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buf.length < offset + 2) return null;
    length = buf.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error('frame exceeds the maximum message size');
    length = Number(big);
    offset += 8;
  }
  if (length > MAX_MESSAGE_BYTES) throw new Error('frame exceeds the maximum message size');

  // Every frame from a client must be masked; an unmasked one is a protocol error.
  if (!masked) throw new Error('client frame was not masked');
  if (buf.length < offset + 4 + length) return null;

  const mask = buf.subarray(offset, offset + 4);
  offset += 4;

  const payload = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) {
    payload[i] = buf[offset + i]! ^ mask[i % 4]!;
  }
  return { opcode, payload, consumed: offset + length };
}

/** Encode a server frame. Server frames are never masked. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN set: every message here is a single frame.
  return Buffer.concat([header, payload]);
}

export const hub = new SyncHub();
