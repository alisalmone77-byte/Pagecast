/** Minimal WAV reading and writing: 16-bit PCM is all the pipeline needs. */

export interface WavInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly durationMs: number;
}

/** Encode mono 16-bit PCM samples (-1..1) as a RIFF/WAVE file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);          // PCM header size
  buf.writeUInt16LE(1, 20);           // format: PCM
  buf.writeUInt16LE(1, 22);           // channels: mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);           // block align
  buf.writeUInt16LE(16, 34);          // bits per sample
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}

/**
 * Read the format chunk and the real length of the data chunk.
 *
 * The chunks are walked rather than assumed to be at fixed offsets: encoders
 * routinely insert LIST/fact chunks before the data, and a hard-coded offset of
 * 44 silently reports the wrong duration for those files.
 */
export function parseWav(buf: Buffer): WavInfo {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;

  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;

    if (id === 'fmt ' && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      // A streamed encoder may write 0 or 0xffffffff for an unknown length.
      dataBytes = size > 0 && body + size <= buf.length ? size : buf.length - body;
      break;
    }
    // Chunks are word-aligned, so an odd size is followed by a pad byte.
    p = body + size + (size % 2);
  }

  if (sampleRate === 0 || channels === 0 || bitsPerSample === 0) {
    throw new Error('WAVE file has no usable format chunk');
  }
  const bytesPerFrame = channels * (bitsPerSample / 8);
  const durationMs = bytesPerFrame > 0 ? (dataBytes / bytesPerFrame / sampleRate) * 1000 : 0;
  return { sampleRate, channels, bitsPerSample, durationMs: Math.round(durationMs) };
}

/** Raw PCM frames of a WAV file, plus the format they are in. */
export interface WavData extends WavInfo {
  readonly pcm: Buffer;
}

/** Read the PCM payload as well as the format. */
export function readWav(buf: Buffer): WavData {
  const info = parseWav(buf);

  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'data') {
      const length = size > 0 && body + size <= buf.length ? size : buf.length - body;
      return { ...info, pcm: buf.subarray(body, body + length) };
    }
    p = body + size + (size % 2);
  }
  throw new Error('WAVE file has no data chunk');
}

/**
 * Join several WAV files into one.
 *
 * Needed because a provider that caps its input length makes one logical chunk
 * arrive as several responses. Concatenating the encoded files byte-for-byte
 * would embed a RIFF header in the middle of the audio, which decodes as a
 * click; the payloads have to be joined and re-wrapped.
 */
export function concatWav(parts: readonly Buffer[]): Buffer {
  if (parts.length === 0) throw new Error('nothing to concatenate');
  const first = parts[0]!;
  if (parts.length === 1) return first;

  const decoded = parts.map(readWav);
  const head = decoded[0]!;
  for (const part of decoded) {
    if (part.sampleRate !== head.sampleRate || part.channels !== head.channels
      || part.bitsPerSample !== head.bitsPerSample) {
      throw new Error('cannot concatenate WAV files with different formats');
    }
  }

  const pcm = Buffer.concat(decoded.map((d) => d.pcm));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(head.channels, 22);
  header.writeUInt32LE(head.sampleRate, 24);
  header.writeUInt32LE(head.sampleRate * head.channels * (head.bitsPerSample / 8), 28);
  header.writeUInt16LE(head.channels * (head.bitsPerSample / 8), 32);
  header.writeUInt16LE(head.bitsPerSample, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
