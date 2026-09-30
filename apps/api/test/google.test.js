import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PAGECAST_TTS_PROVIDER = 'google';
process.env.GOOGLE_TTS_API_KEY = 'test-key';

const { GoogleTtsProvider, buildSsml, escapeSsml, markIndex, parseVoiceId, splitForInputLimit } =
  await import('../dist/tts/google.js');
const { concatWav, encodeWav, parseWav, readWav } = await import('../dist/tts/wav.js');

const entry = (i, text, cost = 2, pauseMs = 0) => ({
  blockIndex: 0, tokenIndex: i, text, cost, pauseMs,
});

/* ----------------------------------------------------------------- SSML */

test('every word gets its own mark, numbered by position', () => {
  const ssml = buildSsml([entry(0, 'The'), entry(1, 'quick'), entry(2, 'fox')]);
  assert.equal(ssml, '<speak><mark name="w0"/>The <mark name="w1"/>quick <mark name="w2"/>fox</speak>');
});

test('XML characters are escaped', () => {
  // An unescaped & or < makes Google reject the whole request, and both turn up
  // in ordinary prose.
  assert.equal(escapeSsml('Marks & Spencer'), 'Marks &amp; Spencer');
  assert.equal(escapeSsml('a < b > c'), 'a &lt; b &gt; c');
  assert.equal(escapeSsml(`it's "quoted"`), 'it&apos;s &quot;quoted&quot;');
  assert.equal(escapeSsml('&amp;'), '&amp;amp;', 'escaping must not be applied twice');
});

test('escaped text still produces valid SSML', () => {
  const ssml = buildSsml([entry(0, 'Marks'), entry(1, '&'), entry(2, "Spencer's")]);
  assert.ok(ssml.includes('&amp;'));
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(ssml), 'no bare ampersands may survive');
});

test('mark names round-trip, and anything else is rejected', () => {
  assert.equal(markIndex('w0'), 0);
  assert.equal(markIndex('w137'), 137);
  for (const bad of [undefined, '', 'w', 'x1', 'w1x', 'wa']) {
    assert.equal(markIndex(bad), null, `${bad} should not parse`);
  }
});

test('voice ids split into a language code and a voice name', () => {
  assert.deepEqual(parseVoiceId('google-en-GB-Neural2-A'), { languageCode: 'en-GB', name: 'en-GB-Neural2-A' });
  assert.deepEqual(parseVoiceId('google-en-US-Studio-O'), { languageCode: 'en-US', name: 'en-US-Studio-O' });
  assert.deepEqual(parseVoiceId('nonsense'), { languageCode: 'en-US', name: 'nonsense' });
});

/* -------------------------------------------------------------- batching */

test('a plan within the limit stays one batch', () => {
  const plan = Array.from({ length: 20 }, (_, i) => entry(i, 'word'));
  assert.equal(splitForInputLimit(plan).length, 1);
});

test('a long plan is split, and every word survives exactly once', () => {
  const plan = Array.from({ length: 400 }, (_, i) => entry(i, `word${i}`));
  const batches = splitForInputLimit(plan);
  assert.ok(batches.length > 1, 'a 400-word chunk must not go in one request');

  const flat = batches.flat();
  assert.equal(flat.length, plan.length);
  assert.deepEqual(flat.map((e) => e.tokenIndex), plan.map((e) => e.tokenIndex));
  for (const batch of batches) {
    assert.ok(Buffer.byteLength(buildSsml(batch), 'utf8') <= 4200, 'each batch must fit the input limit');
  }
});

test('a single word longer than the limit still produces one batch', () => {
  // Never silently drop a word: one oversized request is the caller's problem
  // to see, an empty batch list is a silent hole in the audio.
  const batches = splitForInputLimit([entry(0, 'x'.repeat(9000))]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
});

test('an empty plan produces no batches', () => {
  assert.deepEqual(splitForInputLimit([]), []);
});

/* ------------------------------------------------------------------ wav */

function wav(seconds, rate = 24_000) {
  return encodeWav(new Float32Array(Math.round(seconds * rate)), rate);
}

test('concatenating WAV files sums their duration and keeps one header', () => {
  const joined = concatWav([wav(1), wav(0.5), wav(0.25)]);
  const info = parseWav(joined);
  assert.equal(info.sampleRate, 24_000);
  assert.equal(info.durationMs, 1750);
  assert.equal(joined.toString('latin1', 0, 4), 'RIFF');
  // The payload must be pure audio, with no embedded header at the seam.
  assert.equal(readWav(joined).pcm.length, readWav(wav(1.75)).pcm.length);
});

test('concatenating a single file returns it unchanged', () => {
  const one = wav(1);
  assert.equal(concatWav([one]), one);
});

test('mismatched formats are refused rather than silently resampled', () => {
  assert.throws(() => concatWav([wav(1, 24_000), wav(1, 16_000)]), /different formats/);
  assert.throws(() => concatWav([]), /nothing to concatenate/);
});

/* -------------------------------------------------------------- requests */

/** Stand in for the API, capturing what was sent. */
function stubGoogle({ timepointsFor = (n) => n, chunkSeconds = 2 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });

    const marks = [...body.input.ssml.matchAll(/name="(w\d+)"/g)].map((m) => m[1]);
    const keep = timepointsFor(marks.length);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        audioContent: wav(chunkSeconds).toString('base64'),
        timepoints: marks.slice(0, keep).map((markName, i) => ({
          markName,
          timeSeconds: (i / Math.max(1, marks.length)) * chunkSeconds,
        })),
      }),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const voice = {
  id: 'google-en-GB-Neural2-A', label: 'Amelia', accent: 'British English',
  gender: 'female', provider: 'google', baseWpm: 165,
};

test('a key is required', () => {
  assert.throws(() => new GoogleTtsProvider(''), /GOOGLE_TTS_API_KEY/);
});

test('synthesis asks for time pointing and linear audio', async () => {
  const stub = stubGoogle();
  try {
    const plan = [entry(0, 'The'), entry(1, 'quick'), entry(2, 'fox')];
    const result = await new GoogleTtsProvider('k').synthesize({ text: 'The quick fox', voice, plan });

    assert.equal(stub.calls.length, 1);
    const { url, body } = stub.calls[0];
    assert.ok(url.includes('v1beta1'), 'time pointing only exists on v1beta1');
    assert.ok(url.includes('key=k'));
    assert.deepEqual(body.enableTimePointing, ['SSML_MARK']);
    assert.equal(body.audioConfig.audioEncoding, 'LINEAR16');
    assert.equal(body.voice.languageCode, 'en-GB');
    assert.equal(body.voice.name, 'en-GB-Neural2-A');
    assert.ok(body.input.ssml.startsWith('<speak>'));
    // Speed is applied on the device, so one rendering serves every rate.
    assert.equal(body.audioConfig.speakingRate, undefined);

    assert.equal(result.ext, 'wav');
    assert.equal(result.durationMs, 2000);
    assert.equal(result.marks.length, 3, 'a real timing for every word');
    assert.deepEqual(result.marks.map((m) => m.tokenIndex), [0, 1, 2]);
  } finally {
    stub.restore();
  }
});

test('marks from several batches are offset onto one timeline', async () => {
  const stub = stubGoogle({ chunkSeconds: 3 });
  try {
    const plan = Array.from({ length: 400 }, (_, i) => entry(i, `word${i}`));
    const result = await new GoogleTtsProvider('k').synthesize({ text: '', voice, plan });

    assert.ok(stub.calls.length > 1, 'this plan must need several requests');
    assert.equal(result.marks.length, plan.length, 'every word keeps a timing across the seams');
    assert.equal(result.durationMs, 3000 * stub.calls.length, 'durations add up');

    // The whole timeline must be ordered, not just each batch.
    for (let i = 1; i < result.marks.length; i += 1) {
      assert.ok(result.marks[i].startMs >= result.marks[i - 1].startMs, `mark ${i} went backwards`);
    }
    // And the second batch must start after the first batch's audio.
    assert.ok(result.marks.at(-1).startMs >= 3000, 'later batches must be offset');
  } finally {
    stub.restore();
  }
});

test('incomplete time pointing falls back to estimated timings', async () => {
  // A timeline with holes is worse than one that is uniformly estimated: the
  // highlight would jump over the words that lost their marks.
  const stub = stubGoogle({ timepointsFor: (n) => n - 1 });
  try {
    const plan = [entry(0, 'a'), entry(1, 'b'), entry(2, 'c')];
    const result = await new GoogleTtsProvider('k').synthesize({ text: 'a b c', voice, plan });
    assert.equal(result.marks, undefined, 'the caller should estimate instead');
    assert.equal(result.durationMs, 2000, 'the audio is still good');
  } finally {
    stub.restore();
  }
});

test('an API error surfaces with its status and message', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'Quota exceeded' });
  try {
    await assert.rejects(
      new GoogleTtsProvider('k').synthesize({ text: 'x', voice, plan: [entry(0, 'x')] }),
      /429.*Quota exceeded/s,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('an empty response is an error, not silent silence', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ audioContent: '' }) });
  try {
    await assert.rejects(
      new GoogleTtsProvider('k').synthesize({ text: 'x', voice, plan: [entry(0, 'x')] }),
      /no audio/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('an empty plan makes no request at all', async () => {
  const stub = stubGoogle();
  try {
    const result = await new GoogleTtsProvider('k').synthesize({ text: '', voice, plan: [] });
    assert.equal(stub.calls.length, 0);
    assert.equal(result.durationMs, 0);
  } finally {
    stub.restore();
  }
});

test('the voice catalogue is well formed', () => {
  const voices = new GoogleTtsProvider('k').voices();
  assert.ok(voices.length >= 4);
  for (const v of voices) {
    assert.ok(v.id.startsWith('google-'));
    assert.equal(v.provider, 'google');
    assert.ok(v.baseWpm > 60 && v.baseWpm < 400);
    const { languageCode } = parseVoiceId(v.id);
    assert.match(languageCode, /^[a-z]{2}-[A-Z]{2}$/);
  }
  assert.equal(new Set(voices.map((v) => v.id)).size, voices.length, 'ids must be unique');
});
