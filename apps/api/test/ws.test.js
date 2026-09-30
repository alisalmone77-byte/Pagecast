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
let token;
let strangerToken;

before(async () => {
  await store.init();
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  token = await register('reader@example.com');
  strangerToken = await register('mallory@example.com');
});

async function register(email) {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'a decent long passphrase' }),
  });
  return (await res.json()).token;
}

/** Ingest a document as a given account. */
async function ingest(text, title, as = token) {
  const res = await fetch(`http://127.0.0.1:${port}/api/ingest/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${as}` },
    body: JSON.stringify({ text, title }),
  });
  return (await res.json()).meta;
}

/** Write reading state as a given account. */
function writeState(id, position, deviceId, as = token) {
  return fetch(`http://127.0.0.1:${port}/api/sync/state/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${as}` },
    body: JSON.stringify({ position, rev: 0, deviceId }),
  });
}

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
async function connect(query = '', sessionToken = token) {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const key = randomBytes(16).toString('base64');
  const auth = sessionToken ? `Authorization: Bearer ${sessionToken}\r\n` : '';
  socket.write(
    `GET /api/sync/ws${query} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n` +
    `Connection: Upgrade\r\n${auth}Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
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
  const client = await connect('?device=laptop');
  assert.match(client.handshake, /^HTTP\/1\.1 101 /);

  const expected = createHash('sha1')
    .update(client.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  assert.match(client.handshake, new RegExp(`Sec-WebSocket-Accept: ${expected.replace(/[+/=]/g, '\\$&')}`, 'i'));
  client.close();
});

test('a connecting client is greeted and can subscribe', async () => {
  const client = await connect('?device=laptop');
  const hello = await client.next();
  assert.equal(hello.type, 'hello');
  assert.equal(hello.deviceId, 'laptop');

  client.send({ type: 'subscribe', documentIds: ['doc-a'] });
  const ack = await client.next();
  assert.deepEqual(ack.documentIds, ['doc-a']);
  client.close();
});

test('an unauthenticated upgrade is refused', async () => {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(
    'GET /api/sync/ws?device=nobody HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n' +
    `Connection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
    'Sec-WebSocket-Version: 13\r\n\r\n',
  );
  const response = await new Promise((resolve) => socket.once('data', (d) => resolve(d.toString())));
  assert.match(response, /401/);
  socket.destroy();
});

test('a bogus session cannot open a socket', async () => {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(
    'GET /api/sync/ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n' +
    'Connection: Upgrade\r\nAuthorization: Bearer not-a-real-token\r\n' +
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  const response = await new Promise((resolve) => socket.once('data', (d) => resolve(d.toString())));
  assert.match(response, /401/);
  socket.destroy();
});

test('a position written on one device reaches the other', async () => {
  const meta = await ingest('One two three.\n\nFour five six.\n\nSeven eight nine.', 'Handoff');

  const phone = await connect('?device=phone');
  await phone.next(); // hello

  await writeState(meta.id, { blockIndex: 2, tokenIndex: 1 }, 'laptop');

  const pushed = await phone.next();
  assert.equal(pushed.type, 'state');
  assert.equal(pushed.originDeviceId, 'laptop');
  assert.equal(pushed.state.documentId, meta.id);
  assert.equal(pushed.state.position.blockIndex, 2);
  phone.close();
});

test('a device is not sent the echo of its own write', async () => {
  const meta = await ingest('Alpha beta.\n\nGamma delta.', 'Echo');
  const laptop = await connect('?device=laptop');
  await laptop.next();

  await writeState(meta.id, { blockIndex: 1, tokenIndex: 0 }, 'laptop');

  await assert.rejects(() => laptop.next(), /timed out/);
  laptop.close();
});

test('another account never sees this account traffic', async () => {
  const meta = await ingest('Private one.\n\nPrivate two.', 'Private');

  // A real, separate account with its own live socket.
  const stranger = await connect('?device=other', strangerToken);
  await stranger.next();

  await writeState(meta.id, { blockIndex: 1, tokenIndex: 0 }, 'my-phone');

  await assert.rejects(() => stranger.next(), /timed out/);
  stranger.close();
});

test('subscribing to another account document pushes nothing', async () => {
  const meta = await ingest('Not for you.\n\nStill not.', 'Sealed');

  const stranger = await connect('?device=snoop', strangerToken);
  await stranger.next();
  // The subscription is accepted -- the server does not confirm or deny that
  // the id exists -- but no traffic for it is ever delivered.
  stranger.send({ type: 'subscribe', documentIds: [meta.id] });
  await stranger.next();

  await writeState(meta.id, { blockIndex: 1, tokenIndex: 0 }, 'my-laptop');
  await assert.rejects(() => stranger.next(), /timed out/);
  stranger.close();
});

test('a subscribed client only hears about its own documents', async () => {
  const watched = await ingest('One two.\n\nThree four.', 'Watched');
  const ignored = await ingest('One two.\n\nThree four.', 'Ignored');

  const client = await connect('?device=tablet');
  await client.next();
  client.send({ type: 'subscribe', documentIds: [watched.id] });
  await client.next();

  await writeState(ignored.id, { blockIndex: 1, tokenIndex: 0 }, 'laptop');
  await writeState(watched.id, { blockIndex: 1, tokenIndex: 0 }, 'laptop');

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

test('a socket reset during the handshake does not take the server down', async () => {
  // An upgrade hands over a raw socket with no error handling of its own. A
  // client that connects and immediately resets used to raise an unhandled
  // 'error' event and kill the process -- a crash anyone on the network could
  // trigger at will.
  const reset = (withAuth, delayMs) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => {});
    socket.on('connect', () => {
      socket.write(
        'GET /api/sync/ws?device=reset HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n' +
        `Connection: Upgrade\r\n${withAuth ? `Authorization: Bearer ${token}\r\n` : ''}` +
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n',
      );
      setTimeout(() => { socket.resetAndDestroy(); resolve(); }, delayMs);
    });
    setTimeout(resolve, 300);
  });

  for (let i = 0; i < 6; i += 1) await reset(i % 2 === 0, i % 3);
  await new Promise((r) => setTimeout(r, 300));

  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(res.status, 200, 'the server must still be answering');

  // And it must still work, not merely be alive.
  const client = await connect('?device=after-reset');
  assert.equal((await client.next()).type, 'hello');
  client.close();
});

test('a malformed request gets a 400 rather than killing the process', async () => {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write('NOT-HTTP \x00 garbage\r\n\r\n');
  const response = await new Promise((resolve) => {
    socket.once('data', (d) => resolve(d.toString()));
    setTimeout(() => resolve(''), 1000);
  });
  socket.destroy();
  assert.match(response, /400/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
});

test('malformed JSON over the socket gets an error, not a dropped connection', async () => {
  const client = await connect('?device=laptop');
  await client.next();
  client.sendRaw(clientFrame(0x1, Buffer.from('{ not json')));
  const err = await client.next();
  assert.equal(err.type, 'error');
  client.close();
});
