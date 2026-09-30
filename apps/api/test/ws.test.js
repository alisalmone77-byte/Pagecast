import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pagecast-ws-'));
process.env.PAGECAST_DATA_DIR = dataDir;
process.env.PAGECAST_TTS_PROVIDER = 'local';

const { decodeFrame, encodeFrame } = await import('../dist/ws.js');
const { createServer } = await import('../dist/server.js');
const { store } = await import('../dist/store.js');

let server;
let port;

before(async () => {
  await store.init();
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** Mask a client frame, as RFC 6455 requires of every client-to-server frame. */
function clientFrame(opcode, payload) {
  const mask = randomBytes(4);
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** Open a WebSocket by hand and collect decoded server messages. */
async function connect(query = '') {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const key = randomBytes(16).toString('base64');
  socket.write(
    `GET /api/sync/ws${query} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n` +
    `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );

  let buffer = Buffer.alloc(0);
  let handshake = null;
  const messages = [];
  const waiters = [];

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (handshake === null) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      handshake = buffer.subarray(0, end).toString('latin1');
      buffer = buffer.subarray(end + 4);
    }
    // Server frames are unmasked, so decode them directly.
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x1) {
        const message = JSON.parse(payload.toString('utf8'));
        const waiter = waiters.shift();
        if (waiter) waiter(message);
        else messages.push(message);
      }
    }
  });

  await new Promise((resolve) => {
    const check = () => (handshake !== null ? resolve() : setTimeout(check, 5));
    check();
  });

  return {
    handshake,
    key,
    messages,
    send: (obj) => socket.write(clientFrame(0x1, Buffer.from(JSON.stringify(obj)))),
    sendRaw: (buf) => socket.write(buf),
    next: () => new Promise((resolve, reject) => {
      const queued = messages.shift();
      if (queued !== undefined) { resolve(queued); return; }
      const timer = setTimeout(() => reject(new Error('timed out waiting for a server message')), 1500);
      waiters.push((m) => { clearTimeout(timer); resolve(m); });
    }),
    close: () => socket.destroy(),
    socket,
  };
}

test('frames round-trip through the encoder and decoder', () => {
  for (const size of [0, 5, 125, 126, 300, 70_000]) {
    const payload = randomBytes(size);
    // Re-mask the server-encoded frame so the decoder sees a valid client frame.
    const framed = clientFrame(0x1, payload);
    const decoded = decodeFrame(framed);
    assert.ok(decoded, `size ${size} should decode`);
    assert.equal(decoded.opcode, 0x1);
    assert.deepEqual(decoded.payload, payload);
    assert.equal(decoded.consumed, framed.length);
  }
});

test('the decoder returns null until a whole frame has arrived', () => {
  const framed = clientFrame(0x1, Buffer.from('hello world'));
  for (let cut = 1; cut < framed.length; cut += 1) {
    assert.equal(decodeFrame(framed.subarray(0, cut)), null, `partial frame of ${cut} bytes must not decode`);
  }
  assert.ok(decodeFrame(framed));
});

test('an unmasked client frame is rejected', () => {
  assert.throws(() => decodeFrame(encodeFrame(0x1, Buffer.from('hi'))), /not masked/);
});

test('an oversized frame is rejected before it is buffered', () => {
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(50 * 1024 * 1024), 2);
  assert.throws(() => decodeFrame(header), /maximum message size/);
});

test('server frames are never masked', () => {
  const frame = encodeFrame(0x1, Buffer.from('abc'));
  assert.equal((frame[1] & 0x80) === 0, true);
});

test('the handshake completes with a correct accept key', async () => {
  const client = await connect('?user=local&device=laptop');
  assert.match(client.handshake, /^HTTP\/1\.1 101 /);

  const expected = createHash('sha1')
    .update(client.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  assert.match(client.handshake, new RegExp(`Sec-WebSocket-Accept: ${expected.replace(/[+/=]/g, '\\$&')}`, 'i'));
  client.close();
});

test('a connecting client is greeted and can subscribe', async () => {
  const client = await connect('?user=local&device=laptop');
  const hello = await client.next();
  assert.equal(hello.type, 'hello');
  assert.equal(hello.deviceId, 'laptop');

  client.send({ type: 'subscribe', documentIds: ['doc-a'] });
  const ack = await client.next();
  assert.deepEqual(ack.documentIds, ['doc-a']);
  client.close();
});

test('a position written on one device reaches the other', async () => {
  const ingest = await fetch(`http://127.0.0.1:${port}/api/ingest/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'One two three.\n\nFour five six.\n\nSeven eight nine.', title: 'Handoff' }),
  });
  const { meta } = await ingest.json();

  const phone = await connect('?user=local&device=phone');
  await phone.next(); // hello

  await fetch(`http://127.0.0.1:${port}/api/sync/state/${meta.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ position: { blockIndex: 2, tokenIndex: 1 }, rev: 0, deviceId: 'laptop' }),
  });

  const pushed = await phone.next();
  assert.equal(pushed.type, 'state');
  assert.equal(pushed.originDeviceId, 'laptop');
  assert.equal(pushed.state.documentId, meta.id);
  assert.equal(pushed.state.position.blockIndex, 2);
  phone.close();
});

test('a device is not sent the echo of its own write', async () => {
  const ingest = await fetch(`http://127.0.0.1:${port}/api/ingest/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Alpha beta.\n\nGamma delta.', title: 'Echo' }),
  });
  const { meta } = await ingest.json();

  const laptop = await connect('?user=local&device=laptop');
  await laptop.next();

  await fetch(`http://127.0.0.1:${port}/api/sync/state/${meta.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ position: { blockIndex: 1, tokenIndex: 0 }, rev: 0, deviceId: 'laptop' }),
  });

  await assert.rejects(() => laptop.next(), /timed out/);
  laptop.close();
});

test('another user never sees this user traffic', async () => {
  const ingest = await fetch(`http://127.0.0.1:${port}/api/ingest/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Private one.\n\nPrivate two.', title: 'Private' }),
  });
  const { meta } = await ingest.json();

  const stranger = await connect('?user=mallory&device=other');
  await stranger.next();

  await fetch(`http://127.0.0.1:${port}/api/sync/state/${meta.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-pagecast-user': 'alice' },
    body: JSON.stringify({ position: { blockIndex: 1, tokenIndex: 0 }, rev: 0, deviceId: 'alice-phone' }),
  });

  await assert.rejects(() => stranger.next(), /timed out/);
  stranger.close();
});

test('a subscribed client only hears about its own documents', async () => {
  const mk = async (title) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/ingest/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'One two.\n\nThree four.', title }),
    });
    return (await r.json()).meta;
  };
  const watched = await mk('Watched');
  const ignored = await mk('Ignored');

  const client = await connect('?user=local&device=tablet');
  await client.next();
  client.send({ type: 'subscribe', documentIds: [watched.id] });
  await client.next();

  const write = (id) => fetch(`http://127.0.0.1:${port}/api/sync/state/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ position: { blockIndex: 1, tokenIndex: 0 }, rev: 0, deviceId: 'laptop' }),
  });

  await write(ignored.id);
  await write(watched.id);

  const message = await client.next();
  assert.equal(message.state.documentId, watched.id, 'the unsubscribed document must not be pushed');
  client.close();
});

test('an upgrade on the wrong path is refused', async () => {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(
    'GET /api/wrong HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n' +
    `Connection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
  );
  const response = await new Promise((resolve) => socket.once('data', (d) => resolve(d.toString())));
  assert.match(response, /404/);
  socket.destroy();
});

test('malformed JSON over the socket gets an error, not a dropped connection', async () => {
  const client = await connect('?user=local&device=laptop');
  await client.next();
  client.sendRaw(clientFrame(0x1, Buffer.from('{ not json')));
  const err = await client.next();
  assert.equal(err.type, 'error');
  client.close();
});
